// FORGE API: one Fastify process standing in for the blueprint's project, asset-library, scene, telemetry-gateway, connector,
// twin-runtime, simulation, optimization, collaboration, version-control and reporting services (README "Not built" says why).
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Replica, compare, compile, ExprError, merge, diff, parseScene, replicate, simulate, sizeBuffer, templateFactory, SceneError, LIBRARY, canonical as canon,
  type Op, type Scene, type Link, type Binding,
} from "../../../packages/domain/src/index.ts";
import { audit, pool, sha256, withTenant } from "./db.ts";
import { encrypt } from "./secrets.ts";
import { Hub } from "./hub.ts";

interface Auth { org: string; slug: string; role: "viewer" | "engineer" | "admin"; label: string }
declare module "fastify" { interface FastifyRequest { auth?: Auth; traceId: string; t0: bigint } }
class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

const Err = { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, traceId: { type: "string" }, details: {} } } } };
const Obj = { type: "object", additionalProperties: true };
const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const Asset = { type: "object", required: ["id", "type", "name", "transform", "props"], additionalProperties: true, properties: { id: { type: "string", pattern: "^[\\w-]{1,60}$" }, type: { type: "string", enum: Object.keys(LIBRARY) }, name: { type: "string", maxLength: 80 }, transform: { type: "object", required: ["position", "rotation", "scale"], properties: { position: V3, rotation: V3, scale: V3 } }, props: { type: "object", additionalProperties: { type: "number" } } } };
const idem = { type: "object", properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } }, required: ["idempotency-key"] };
const sec = [{ bearer: [] }];
const Estimate = { type: "object", properties: { mean: { type: "number" }, lo: { type: "number" }, hi: { type: "number" }, n: { type: "integer" } } };
const KpisS = { type: "object", additionalProperties: true, properties: { throughputPerH: Estimate, cycleMeanS: Estimate, wipAvg: Estimate, runs: { type: "integer" }, assumptions: { type: "array", items: { type: "string" } } } };

function limiter(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), s = b.get(key) ?? { tokens: capacity, at: now };
    s.tokens = Math.min(capacity, s.tokens + ((now - s.at) / 1000) * perSec); s.at = now;
    const ok = s.tokens >= 1; if (ok) s.tokens -= 1; b.set(key, s);
    return { ok, remaining: Math.floor(s.tokens), resetS: Math.ceil((capacity - s.tokens) / perSec) };
  };
}

export async function build(opts: { rateLimit?: number; logger?: boolean; hub?: Hub | null } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, genReqId: () => randomBytes(8).toString("hex"), bodyLimit: 512 * 1024 });
  const hub = opts.hub === undefined ? new Hub(process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883", process.env.MQTT_USER, process.env.MQTT_PASS) : opts.hub;
  hub?.start();
  const limit = limiter(opts.rateLimit ?? 300, (opts.rateLimit ?? 300) / 60);
  const metrics = new Map<string, { n: number; errors: number; lat: number[] }>();
  const rooms = new Map<string, Set<{ send: (s: string) => void; actor: string }>>(); // presence / collab relay per project

  await app.register(swagger, { openapi: { openapi: "3.1.0", info: { title: "FORGE API", version: "1.0.0", description: "Industrial digital-twin builder on synthetic data. Mutations need an Idempotency-Key. Errors are {error:{code,message,traceId}}. Lists take ?limit and ?cursor." }, components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, servers: [{ url: "http://localhost:8520" }] } });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    req.t0 = process.hrtime.bigint();
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(String(req.headers.traceparent ?? ""));
    req.traceId = m ? m[1] : randomBytes(16).toString("hex");
    reply.header("traceparent", `00-${req.traceId}-${randomBytes(8).toString("hex")}-01`).header("x-content-type-options", "nosniff").header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const origin = String(req.headers.origin ?? "");
    if ((process.env.CORS_ORIGINS ?? "http://localhost:8521,http://127.0.0.1:8521").split(",").includes(origin)) reply.header("access-control-allow-origin", origin).header("vary", "origin").header("access-control-allow-headers", "authorization,content-type,idempotency-key,traceparent").header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS").header("access-control-expose-headers", "traceparent,ratelimit-remaining");
    if (req.method === "OPTIONS") return reply.code(204).send();
    // WebSockets cannot send headers from the browser, so they pass the token as a query parameter
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "") || (req.url.includes("token=") ? new URL(req.url, "http://x").searchParams.get("token") ?? "" : "");
    if (token) {
      const r = await pool.query("SELECT t.role, t.label, o.id, o.slug FROM api_tokens t JOIN organizations o ON o.id = t.organization_id WHERE t.token_sha256 = $1", [sha256(token)]);
      if (!r.rows[0]) throw new ApiError(401, "unauthenticated", "unknown token");
      req.auth = { org: r.rows[0].id, slug: r.rows[0].slug, role: r.rows[0].role, label: r.rows[0].label };
    }
    const rl = limit(req.auth?.label ?? req.ip);
    reply.header("ratelimit-limit", opts.rateLimit ?? 300).header("ratelimit-remaining", rl.remaining).header("ratelimit-reset", rl.resetS);
    if (!rl.ok) { reply.header("retry-after", rl.resetS); throw new ApiError(429, "rate_limited", "too many requests"); }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
    const m = metrics.get(route) ?? { n: 0, errors: 0, lat: [] };
    m.n++; if (reply.statusCode >= 500) m.errors++;
    m.lat.push(Number(process.hrtime.bigint() - req.t0) / 1e6); if (m.lat.length > 2000) m.lat.shift();
    metrics.set(route, m);
    req.log.info({ traceId: req.traceId, route, status: reply.statusCode, tenant: req.auth?.slug }, "request");
  });
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, traceId: req.traceId, details: e.details } });
    if (e instanceof SceneError || e instanceof ExprError) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    if (e.validation) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    req.log.error({ err: e, traceId: req.traceId }, "unhandled");
    const code = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(code).send({ error: { code: code < 500 ? "invalid_request" : "internal", message: code < 500 ? e.message : "internal error", traceId: req.traceId } });
  });

  const need = (req: FastifyRequest, write = false): Auth => {
    if (!req.auth) throw new ApiError(401, "unauthenticated", "Bearer token required");
    if (write && req.auth.role === "viewer") throw new ApiError(403, "forbidden", "viewer tokens cannot change anything");
    return req.auth;
  };
  async function idempotent(req: FastifyRequest, reply: FastifyReply, run: (a: Auth) => Promise<{ status: number; body: unknown }>) {
    const a = need(req, true), key = String(req.headers["idempotency-key"]), hash = sha256(canon(req.body ?? null) + req.url);
    const prior = await withTenant(a.org, (c) => c.query("SELECT request_sha256, status, response FROM idempotency_keys WHERE key = $1", [key]));
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw new ApiError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request");
      return reply.code(prior.rows[0].status).header("idempotent-replayed", "true").send(prior.rows[0].response);
    }
    const out = await run(a);
    await withTenant(a.org, (c) => c.query("INSERT INTO idempotency_keys (tenant_id, key, method, path, request_sha256, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [a.org, key, req.method, req.url, hash, out.status, out.body ?? {}]));
    return reply.code(out.status).send(out.body);
  }
  const project = async (a: Auth, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, "not_found", `no project ${id}`);
    const r = await withTenant(a.org, (c) => c.query("SELECT id, name FROM twin_projects WHERE id = $1", [id]));
    if (!r.rows[0]) throw new ApiError(404, "not_found", `no project ${id}`); // other tenants' projects are invisible, so they 404 too
    return r.rows[0] as { id: string; name: string };
  };
  /** A branch's scene: its base snapshot plus every stored op, replayed through the same Replica the browser uses. */
  const branchScene = async (a: Auth, pid: string, bid: string): Promise<Scene> => {
    return withTenant(a.org, async (c) => {
      const b = await c.query("SELECT base_scene FROM scenario_branches WHERE project_id = $1 AND id = $2", [pid, bid]);
      if (!b.rows[0]) throw new ApiError(404, "not_found", `no branch ${bid}`);
      const base = parseScene(b.rows[0].base_scene);
      const rep = new Replica("server", base);
      const ops = await c.query("SELECT op FROM scene_ops WHERE project_id = $1 AND branch_id = $2 ORDER BY seq", [pid, bid]);
      const links = [...base.links];
      for (const { op } of ops.rows) { if (op.kind === "link") { if (!links.some((l) => l.from === op.from && l.to === op.to)) links.push({ from: op.from, to: op.to }); } else rep.apply(op as Op); }
      return { ...rep.scene({ ...base, links }), bindings: base.bindings, comments: [] };
    });
  };
  const appendOp = (a: Auth, pid: string, bid: string, op: unknown) => withTenant(a.org, async (c) => {
    const b = await c.query("SELECT 1 FROM scenario_branches WHERE project_id = $1 AND id = $2", [pid, bid]);
    if (!b.rows[0]) throw new ApiError(404, "not_found", `no branch ${bid}`);
    await c.query("INSERT INTO scene_ops (project_id, branch_id, tenant_id, op) VALUES ($1,$2,$3,$4)", [pid, bid, a.org, op]);
  });
  const syncAsset = (a: Auth, pid: string, asset: Scene["assets"][number] | undefined, id: string) => withTenant(a.org, async (c) => {
    if (!asset) { await c.query("UPDATE assets SET deleted_at = now() WHERE project_id = $1 AND id = $2", [pid, id]); return; }
    await c.query(`INSERT INTO assets (id, project_id, tenant_id, asset_type, name, transform, properties) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (project_id, id) DO UPDATE SET name = EXCLUDED.name, transform = EXCLUDED.transform, properties = EXCLUDED.properties, deleted_at = NULL, updated_at = now()`,
      [asset.id, pid, a.org, asset.type, asset.name, asset.transform, asset.props]);
  });
  const stamp = (b: { clock?: number; actor?: string }, a: Auth) => ({ clock: Number.isInteger(b.clock) ? b.clock! : Date.now(), actor: String(b.actor ?? a.label).slice(0, 60) });

  // ---------- routes ----------
  app.get("/healthz", { schema: { hide: true } }, async () => { await pool.query("SELECT 1"); return { ok: true, broker: hub?.up ?? false }; });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_, reply) => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const lines: string[] = [];
    for (const [r, m] of metrics) { const l = `route="${r}"`; lines.push(`forge_requests_total{${l}} ${m.n}`, `forge_request_errors_total{${l}} ${m.errors}`); for (const p of [0.5, 0.95, 0.99]) lines.push(`forge_request_latency_ms{${l},quantile="${p}"} ${q(m.lat, p).toFixed(2)}`); }
    if (hub) lines.push(`forge_telemetry_received_total ${hub.stats.received}`, `forge_telemetry_sent_total ${hub.stats.sent}`, `forge_telemetry_ws_clients ${hub.clients.size}`, `forge_broker_up ${hub.up ? 1 : 0}`);
    lines.push(`forge_db_pool_total ${pool.totalCount}`, `forge_db_pool_waiting ${pool.waitingCount}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  app.get("/v1/templates/demo", { schema: { tags: ["projects"], summary: "The demo factory template (public)", response: { 200: { type: "object", properties: { scene: Obj } } } } }, async () => ({ scene: templateFactory() }));

  app.post("/v1/projects", { schema: { tags: ["projects"], security: sec, headers: idem, body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 80 }, template: { type: "string", enum: ["demo", "empty"] } } }, response: { 201: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, branches: { type: "array", items: { type: "string" } } } }, 400: Err, 401: Err, 403: Err, 409: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const b = req.body as { name: string; template?: string };
      const id = randomUUID();
      const scene = b.template === "empty" ? { ...templateFactory(id), assets: [], links: [] } : templateFactory(id);
      await withTenant(a.org, async (c) => {
        await c.query("INSERT INTO twin_projects (id, org_id, tenant_id, name, status, created_by) VALUES ($1,$2,$2,$3,'active',$4)", [id, a.org, b.name, a.label]);
        await c.query("INSERT INTO scenario_branches (id, project_id, tenant_id, parent_branch_id, name, base_scene, created_by) VALUES ('production',$1,$2,NULL,'production',$3,$4)", [id, a.org, scene, a.label]);
        for (const as of scene.assets) await c.query("INSERT INTO assets (id, project_id, tenant_id, asset_type, name, transform, properties) VALUES ($1,$2,$3,$4,$5,$6,$7)", [as.id, id, a.org, as.type, as.name, as.transform, as.props]);
        await audit(c, a.org, a.label, "project.create", id, { name: b.name, assets: scene.assets.length }, req.traceId);
      });
      return { status: 201, body: { id, name: b.name, branches: ["production"] } };
    }));

  app.get("/v1/projects/:id", { schema: { tags: ["projects"], security: sec, params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: Obj, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req), p = await project(a, (req.params as { id: string }).id);
    const br = await withTenant(a.org, (c) => c.query("SELECT id, name, parent_branch_id FROM scenario_branches WHERE project_id = $1 ORDER BY created_at", [p.id]));
    return { ...p, branches: await Promise.all(br.rows.map(async (b) => ({ id: b.id, name: b.name, parentId: b.parent_branch_id, scene: await branchScene(a, p.id, b.id) }))) };
  });

  app.post("/v1/projects/:id/assets", { schema: { tags: ["assets"], security: sec, headers: idem, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["asset"], properties: { branch: { type: "string", default: "production" }, asset: Asset, clock: { type: "integer" }, actor: { type: "string" } } }, response: { 201: Obj, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const p = await project(a, (req.params as { id: string }).id), b = req.body as { branch: string; asset: Scene["assets"][number]; clock?: number; actor?: string };
      parseScene({ version: 1, id: "check", name: "check", assets: [b.asset], links: [] }); // same validation as the editor
      await appendOp(a, p.id, b.branch, { kind: "add", asset: b.asset, ...stamp(b, a) });
      if (b.branch === "production") await syncAsset(a, p.id, b.asset, b.asset.id);
      return { status: 201, body: { id: b.asset.id, branch: b.branch } };
    }));

  app.patch("/v1/assets/:id/transform", { schema: { tags: ["assets"], security: sec, headers: idem, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" }, branch: { type: "string", default: "production" }, position: V3, rotation: V3, scale: V3, clock: { type: "integer" }, actor: { type: "string" } } }, response: { 200: Obj, 400: Err, 401: Err, 403: Err, 404: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const id = (req.params as { id: string }).id, b = req.body as { projectId: string; branch: string; position?: number[]; rotation?: number[]; scale?: number[]; clock?: number; actor?: string };
      const p = await project(a, b.projectId);
      const sc = await branchScene(a, p.id, b.branch);
      const asset = sc.assets.find((x) => x.id === id);
      if (!asset) throw new ApiError(404, "not_found", `no asset ${id} on ${b.branch}`);
      if (b.scale?.some((x) => !(x > 0))) throw new ApiError(400, "invalid_request", "scale must be positive");
      const st = stamp(b, a);
      let tick = 0; // one Lamport tick per field: (actor, clock) identifies an op, so fields must not share a stamp
      for (const f of ["position", "rotation", "scale"] as const) if (b[f]) await appendOp(a, p.id, b.branch, { kind: "set", id, field: f, value: b[f], ...st, clock: st.clock + tick++ });
      const after = (await branchScene(a, p.id, b.branch)).assets.find((x) => x.id === id);
      if (b.branch === "production") await syncAsset(a, p.id, after, id);
      return { status: 200, body: { id, transform: after?.transform } };
    }));

  app.post("/v1/projects/:id/ops", { schema: { tags: ["assets"], security: sec, headers: idem, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["op"], properties: { branch: { type: "string", default: "production" }, op: Obj } }, response: { 201: Obj, 400: Err, 401: Err, 403: Err, 404: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const p = await project(a, (req.params as { id: string }).id), b = req.body as { branch: string; op: Op };
      if (!["set", "remove", "add"].includes(b.op.kind)) throw new ApiError(400, "invalid_request", "op.kind must be add, set or remove");
      if (b.op.kind === "set" && !/^(position|rotation|scale|name|props\.\w{1,40})$/.test(b.op.field)) throw new ApiError(400, "invalid_request", "unknown field");
      await appendOp(a, p.id, b.branch, b.op);
      if (b.branch === "production") { const id = b.op.kind === "add" ? b.op.asset.id : b.op.id; await syncAsset(a, p.id, (await branchScene(a, p.id, "production")).assets.find((x) => x.id === id), id); }
      return { status: 201, body: { ok: true } };
    }));

  app.post("/v1/projects/:id/links", { schema: { tags: ["assets"], security: sec, headers: idem, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["from", "to"], properties: { branch: { type: "string", default: "production" }, from: { type: "string" }, to: { type: "string" } } }, response: { 201: Obj, 400: Err, 401: Err, 403: Err, 404: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const p = await project(a, (req.params as { id: string }).id), b = req.body as Link & { branch: string };
      const sc = await branchScene(a, p.id, b.branch);
      if (!sc.assets.some((x) => x.id === b.from) || !sc.assets.some((x) => x.id === b.to) || b.from === b.to) throw new ApiError(400, "invalid_request", "both ends must be assets on the branch");
      await appendOp(a, p.id, b.branch, { kind: "link", from: b.from, to: b.to });
      return { status: 201, body: { ok: true } };
    }));

  app.post("/v1/connectors", { schema: { tags: ["telemetry"], security: sec, headers: idem, body: { type: "object", required: ["projectId", "connectorType"], properties: { projectId: { type: "string" }, connectorType: { type: "string", enum: ["mqtt", "opcua", "modbus_gateway", "rest", "kafka"] }, preset: { type: "string", enum: ["demo-broker"] }, config: { type: "object", properties: { url: { type: "string", pattern: "^(mqtts?|opc\\.tcp|https?)://" }, username: { type: "string" }, password: { type: "string" } } } } },
      response: { 201: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, status: { type: "string" }, label: { type: "string" } } }, 400: Err, 401: Err, 403: Err, 404: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const b = req.body as { projectId: string; connectorType: string; preset?: string; config?: { url: string; username?: string; password?: string } };
      const p = await project(a, b.projectId);
      // the demo preset uses the platform's own broker credentials, so the browser never holds an OT secret
      const config = b.preset === "demo-broker" ? { url: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883", username: process.env.MQTT_USER, password: process.env.MQTT_PASS } : b.config;
      if (!config?.url) throw new ApiError(400, "invalid_request", "give config.url or preset");
      const id = randomUUID(), label = `${b.connectorType.toUpperCase()} ${new URL(config.url).host}`;
      await withTenant(a.org, async (c) => {
        await c.query("INSERT INTO connectors (id, project_id, tenant_id, connector_type, config_encrypted, label, status) VALUES ($1,$2,$3,$4,$5,$6,'active')", [id, p.id, a.org, b.connectorType, encrypt(config), label]);
        await audit(c, a.org, a.label, "connector.create", id, { type: b.connectorType, host: new URL(config.url).host }, req.traceId);
      });
      hub?.ingest.set(p.id, { tenant: a.org });
      return { status: 201, body: { id, type: b.connectorType, status: "active", label } };
    }));

  app.get("/v1/connectors", { schema: { tags: ["telemetry"], security: sec, querystring: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } }, response: { 200: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, status: { type: "string" }, label: { type: "string" } } } } } }, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req), p = await project(a, (req.query as { projectId: string }).projectId);
    const r = await withTenant(a.org, (c) => c.query("SELECT id, connector_type, status, label FROM connectors WHERE project_id = $1", [p.id]));
    return { items: r.rows.map((x) => ({ id: x.id, type: x.connector_type, status: x.status, label: x.label })) };
  });

  app.post("/v1/bindings", { schema: { tags: ["telemetry"], security: sec, headers: idem, body: { type: "object", required: ["projectId", "id", "assetId", "sourcePath", "targetProperty"], properties: { projectId: { type: "string" }, id: { type: "string", pattern: "^[\\w-]{1,80}$" }, assetId: { type: "string" }, connectorId: { type: "string" }, sourcePath: { type: "string", pattern: "^forge/[\\w-]+/[\\w-]+/[\\w-]+$" }, targetProperty: { type: "string", enum: ["spindleRpm", "temperatureC", "vibration", "status", "flow"] }, transform: { type: "string", maxLength: 120, default: "value" }, unit: { type: "string" } } }, response: { 201: Obj, 400: Err, 401: Err, 403: Err, 404: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const b = req.body as Binding & { projectId: string };
      const p = await project(a, b.projectId);
      compile(b.transform); // refuses anything but arithmetic on `value`
      await withTenant(a.org, async (c) => {
        const as = await c.query("SELECT 1 FROM assets WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL", [p.id, b.assetId]);
        if (!as.rows[0]) throw new ApiError(404, "not_found", `no production asset ${b.assetId} (bindings attach to the live twin)`);
        const conn = /^[0-9a-f-]{36}$/.test(b.connectorId ?? "") ? b.connectorId : (await c.query("SELECT id FROM connectors WHERE project_id = $1 LIMIT 1", [p.id])).rows[0]?.id ?? null;
        await c.query(`INSERT INTO telemetry_bindings (id, project_id, asset_id, tenant_id, connector_id, source_path, target_property, transform_expression, unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (id) DO UPDATE SET source_path = EXCLUDED.source_path, transform_expression = EXCLUDED.transform_expression`, [b.id, p.id, b.assetId, a.org, conn, b.sourcePath, b.targetProperty, b.transform, b.unit ?? ""]);
      });
      return { status: 201, body: { id: b.id } };
    }));

  app.get("/v1/assets/:id/timeseries", { schema: { tags: ["telemetry"], security: sec, params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", required: ["projectId", "metric"], properties: { projectId: { type: "string" }, metric: { type: "string", enum: ["rpm", "temperature", "vibration"] }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 } } }, response: { 200: { type: "object", properties: { points: { type: "array", items: { type: "object", properties: { ts: { type: "string" }, value: { type: "number" } } } } } }, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req), q = req.query as { projectId: string; metric: string; from?: string; to?: string; limit: number };
    const p = await project(a, q.projectId);
    const r = await withTenant(a.org, (c) => c.query("SELECT ts, value FROM telemetry_points WHERE project_id = $1 AND asset_id = $2 AND metric = $3 AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts <= $5) ORDER BY ts DESC LIMIT $6", [p.id, (req.params as { id: string }).id, q.metric, q.from ?? null, q.to ?? null, q.limit]));
    return { points: r.rows.map((x) => ({ ts: new Date(x.ts).toISOString(), value: x.value })) };
  });

  app.post("/v1/projects/:id/branches", { schema: { tags: ["branches"], security: sec, headers: idem, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["id", "name", "parentId"], properties: { id: { type: "string", pattern: "^[\\w-]{1,40}$" }, name: { type: "string", maxLength: 60 }, parentId: { type: "string" } } }, response: { 201: Obj, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const p = await project(a, (req.params as { id: string }).id), b = req.body as { id: string; name: string; parentId: string };
      const base = await branchScene(a, p.id, b.parentId);
      await withTenant(a.org, async (c) => {
        const dup = await c.query("SELECT 1 FROM scenario_branches WHERE project_id = $1 AND id = $2", [p.id, b.id]);
        if (dup.rows[0]) throw new ApiError(409, "conflict", `branch ${b.id} exists`);
        await c.query("INSERT INTO scenario_branches (id, project_id, tenant_id, parent_branch_id, name, base_scene, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [b.id, p.id, a.org, b.parentId, b.name, base, a.label]);
        await audit(c, a.org, a.label, "branch.create", `${p.id}/${b.id}`, { parent: b.parentId }, req.traceId);
      });
      return { status: 201, body: { id: b.id, parentId: b.parentId } };
    }));

  /** Branch ids are names, so simulate/optimize/merge take ?projectId (or the body's projectId). */
  const branchArgs = (req: FastifyRequest) => ({ bid: (req.params as { id: string }).id, pid: String((req.query as { projectId?: string }).projectId ?? (req.body as { projectId?: string })?.projectId ?? "") });

  app.post("/v1/branches/:id/simulate", { schema: { tags: ["simulation"], security: sec, summary: "Discrete-event throughput simulation (30 shifts); with compareTo, paired comparison against another branch", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", properties: { projectId: { type: "string" } } }, body: { type: "object", properties: { projectId: { type: "string" }, scene: Obj, compareTo: { type: "object", properties: { branch: { type: "string" }, scene: Obj } }, reps: { type: "integer", minimum: 5, maximum: 60, default: 30 } } }, response: { 200: { type: "object", additionalProperties: true, properties: { kpis: KpisS, base: KpisS, branch: KpisS, throughputDiff: Estimate, significant: { type: "boolean" }, playback: Obj, ms: { type: "number" } } }, 400: Err, 401: Err, 403: Err, 404: Err } } }, async (req) => {
    const a = need(req, true), { bid, pid } = branchArgs(req), body = (req.body ?? {}) as { scene?: unknown; compareTo?: { branch: string; scene?: unknown }; reps: number };
    const t0 = performance.now();
    // the editor may send the scene it shows (it has edits in flight); otherwise use the stored branch
    const scene = body.scene ? parseScene(body.scene) : (pid ? await branchScene(a, (await project(a, pid)).id, bid) : (() => { throw new ApiError(400, "invalid_request", "give projectId or scene"); })());
    let out: Record<string, unknown>;
    try {
      if (body.compareTo) {
        const other = body.compareTo.scene ? parseScene(body.compareTo.scene) : await branchScene(a, (await project(a, pid)).id, body.compareTo.branch);
        out = { ...compare(other, scene, body.reps ?? 30) };
      } else {
        const { raw: _raw, ...kpis } = replicate(scene, body.reps ?? 30);
        out = { kpis, playback: simulate(scene, { hours: 1, warmupH: 1, seed: 1000, recordS: 3600 }) };
      }
    } catch (e) { throw new ApiError(400, "invalid_line", (e as Error).message); }
    out.ms = performance.now() - t0;
    if (pid && /^[0-9a-f-]{36}$/.test(pid)) await withTenant(a.org, async (c) => {
      const ok = await c.query("SELECT 1 FROM scenario_branches WHERE project_id = $1 AND id = $2", [pid, bid]);
      if (ok.rows[0]) await c.query("INSERT INTO simulation_runs (id, project_id, branch_id, tenant_id, engine, status, started_at, completed_at, kpis) VALUES ($1,$2,$3,$4,'des-v1','done',now(),now(),$5)", [randomUUID(), pid, bid, a.org, body.compareTo ? { throughputDiff: out.throughputDiff } : { throughputPerH: (out.kpis as { throughputPerH: unknown }).throughputPerH }]);
    });
    return out;
  });

  app.post("/v1/branches/:id/optimize", { schema: { tags: ["simulation"], security: sec, summary: "Buffer sizing: smallest capacity within 1% of the best throughput", params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["bufferId"], properties: { projectId: { type: "string" }, scene: Obj, bufferId: { type: "string" } } }, response: { 200: Obj, 400: Err, 401: Err, 403: Err, 404: Err } } }, async (req) => {
    const a = need(req, true), { bid, pid } = branchArgs(req), b = req.body as { scene?: unknown; bufferId: string };
    const t0 = performance.now();
    const scene = b.scene ? parseScene(b.scene) : await branchScene(a, (await project(a, pid)).id, bid);
    if (!scene.assets.some((x) => x.id === b.bufferId && x.type === "buffer")) throw new ApiError(400, "invalid_request", `${b.bufferId} is not a buffer on this branch`);
    return { ...sizeBuffer(scene, b.bufferId, 8, 10), ms: performance.now() - t0 };
  });

  app.post("/v1/branches/:id/merge", { schema: { tags: ["branches"], security: sec, headers: idem, summary: "Three-way merge of a branch into its parent; conflicts keep the parent's value and are listed", params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } }, response: { 200: { type: "object", properties: { applied: { type: "integer" }, conflicts: { type: "array", items: Obj }, into: { type: "string" } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } },
    async (req, reply) => idempotent(req, reply, async (a) => {
      const { bid, pid } = branchArgs(req), p = await project(a, pid);
      const row = await withTenant(a.org, (c) => c.query("SELECT parent_branch_id, base_scene FROM scenario_branches WHERE project_id = $1 AND id = $2", [p.id, bid]));
      if (!row.rows[0]) throw new ApiError(404, "not_found", `no branch ${bid}`);
      const parent = row.rows[0].parent_branch_id as string | null;
      if (!parent) throw new ApiError(400, "invalid_request", "production has no parent to merge into");
      const target = await branchScene(a, p.id, parent), source = await branchScene(a, p.id, bid);
      const m = merge(parseScene(row.rows[0].base_scene), target, source);
      let clock = Date.now();
      const st = () => ({ clock: clock++, actor: a.label });
      for (const c of diff(target, m.scene)) {
        if (c.kind === "added") await appendOp(a, p.id, parent, { kind: "add", asset: c.asset, ...st() });
        else if (c.kind === "removed") await appendOp(a, p.id, parent, { kind: "remove", id: c.id, ...st() });
        else if (c.kind === "changed") await appendOp(a, p.id, parent, { kind: "set", id: c.id, field: c.field, value: c.to, ...st() });
        else if (c.kind === "linked") await appendOp(a, p.id, parent, { kind: "link", from: c.link.from, to: c.link.to });
        if (parent === "production" && (c.kind === "added" || c.kind === "changed")) { const id = c.kind === "added" ? c.asset.id : c.id; await syncAsset(a, p.id, m.scene.assets.find((x) => x.id === id), id); }
      }
      await withTenant(a.org, (c) => audit(c, a.org, a.label, "branch.merge", `${p.id}/${bid}`, { into: parent, applied: m.applied, conflicts: m.conflicts.length }, req.traceId));
      return { status: 200, body: { applied: m.applied, conflicts: m.conflicts, into: parent } };
    }));

  app.get("/v1/projects/:id/comments", { schema: { tags: ["collaboration"], security: sec, params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj } } }, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req), p = await project(a, (req.params as { id: string }).id);
    const r = await withTenant(a.org, (c) => c.query("SELECT id, author, asset_id, position, text, created_at FROM comments WHERE project_id = $1 ORDER BY created_at", [p.id]));
    return { items: r.rows.map((x) => ({ id: x.id, author: x.author, assetId: x.asset_id, position: x.position, text: x.text, at: new Date(x.created_at).toISOString() })) };
  });

  app.get("/v1/audit", { schema: { tags: ["admin"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: Obj }, chainValid: { type: "boolean" } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT tenant_id, actor, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY id"));
    let prev = "genesis", ok = true;
    for (const x of r.rows) { if (x.prev_hash !== prev || sha256(prev + canon({ tenant: x.tenant_id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) !== x.hash) ok = false; prev = x.hash; }
    return { items: r.rows.map((x) => ({ actor: x.actor, action: x.action, target: x.target, at: x.at })), chainValid: ok };
  });

  // failure lab (engineer tokens): broker outage, telemetry storm, bearing fault on the simulated plant
  app.post("/v1/lab/:what", { schema: { hide: true } }, async (req) => {
    need(req, true);
    if (!hub) throw new ApiError(503, "no_broker", "telemetry hub not running");
    const what = (req.params as { what: string }).what, b = (req.body ?? {}) as { ms?: number; n?: number; machine?: string };
    if (what === "broker-outage") hub.outage(Math.min(30000, b.ms ?? 6000));
    else if (what === "storm") for (let i = 0; i < Math.min(50000, b.n ?? 20000); i++) hub.publish(`forge/demo/storm/${i % 2000}`, { topic: `forge/demo/storm/${i % 2000}`, ts: Date.now(), value: i, unit: "" });
    else if (what === "fault") hub.publish("forge/demo/control/fault", { machine: String(b.machine ?? "m2") });
    else throw new ApiError(404, "not_found", "unknown lab action");
    return { ok: true };
  });

  app.post("/v1/telemetry", { schema: { hide: true } }, async (req, reply) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object") throw new ApiError(400, "invalid_request", "sample must be an object");
    await pool.query("INSERT INTO client_telemetry (sample) VALUES ($1)", [body]);
    return reply.code(204).send();
  });

  // live telemetry for a project (token in the query string), relayed from the MQTT hub with backpressure
  app.get("/v1/projects/:id/telemetry", { websocket: true, schema: { hide: true } }, async (socket, req) => {
    try {
      const a = need(req); await project(a, (req.params as { id: string }).id);
      if (!hub) { socket.send(JSON.stringify({ status: "broker-down", info: "no telemetry hub" })); return; }
      const off = hub.attach((req.params as { id: string }).id, (s) => socket.send(s), () => socket.bufferedAmount ?? 0);
      socket.on("close", off);
    } catch (e) { socket.send(JSON.stringify({ error: { code: (e as ApiError).code ?? "error", message: (e as Error).message } })); socket.close(); }
  });

  // collaboration relay: ops, links, branches, presence and comments go to every other client of the project; comments persist
  app.get("/v1/projects/:id/presence", { websocket: true, schema: { hide: true } }, async (socket, req) => {
    try {
      const a = need(req), p = await project(a, (req.params as { id: string }).id);
      const actor = String(new URL(req.url, "http://x").searchParams.get("actor") ?? a.label).slice(0, 60);
      const room = rooms.get(p.id) ?? new Set(); rooms.set(p.id, room);
      const me = { send: (s: string) => socket.send(s), actor };
      room.add(me);
      socket.on("message", async (raw: Buffer) => {
        let m: { kind?: string; comment?: { id: string; author: string; assetId: string | null; position: number[]; text: string } };
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (!m || typeof m.kind !== "string" || raw.length > 256 * 1024) return;
        if (m.kind === "comment" && m.comment && a.role !== "viewer") {
          const c = m.comment;
          await withTenant(a.org, (db) => db.query("INSERT INTO comments (id, project_id, tenant_id, author, asset_id, position, text) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [String(c.id).slice(0, 80), p.id, a.org, String(c.author).slice(0, 60), c.assetId, JSON.stringify(c.position), String(c.text).slice(0, 280)])).catch(() => {});
        }
        if ((m.kind === "op" || m.kind === "link" || m.kind === "branch" || m.kind === "binding") && a.role === "viewer") return; // viewers watch, they don't edit
        for (const o of room) if (o !== me) o.send(String(raw));
      });
      socket.on("close", () => room.delete(me));
    } catch (e) { socket.send(JSON.stringify({ error: { message: (e as Error).message } })); socket.close(); }
  });

  app.addHook("onClose", async () => hub?.stop());
  return app;
}
