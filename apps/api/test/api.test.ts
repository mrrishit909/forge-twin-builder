// API contract, authorization matrix, tenant isolation, idempotency, OT secrets, the MQTT connector contract (real Mosquitto
// behind a TCP proxy the test can cut), the telemetry WebSocket relay, collaboration relay, branches, simulation and audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import net from "node:net";
import pg from "pg";
import WebSocket from "ws";
import mqtt from "mqtt";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { build } from "../src/server.ts";
import { pool } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { MqttConnector } from "../src/mqtt-connector.ts";
import { decrypt } from "../src/secrets.ts";
import { connectorContract } from "../../../packages/domain/test/contract.ts";
import { newAsset, type Reading } from "../../../packages/domain/src/index.ts";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://127.0.0.1:18830", USER = process.env.MQTT_USER ?? "forge-demo", PASS = process.env.MQTT_PASS ?? "demo-only-broker-password";
const E = { authorization: "Bearer acme-engineer-demo" }, V = { authorization: "Bearer acme-viewer-demo" }, G = { authorization: "Bearer globex-engineer-demo" };
type App = Awaited<ReturnType<typeof build>>;
let app: App, hub: Hub, port = 0;
let spec: { paths: Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema: object } } }> }>> };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s))).addFormat("uuid", /^[0-9a-f-]{36}$/);
let k = 0;
const key = () => ({ "idempotency-key": `test-key-${Date.now()}-${k++}` });

async function call(method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string> = {}, body?: unknown, route?: string) {
  const r = await app.inject({ method, url, headers: body ? { "content-type": "application/json", ...headers } : headers, payload: body ? JSON.stringify(body) : undefined });
  const schema = spec.paths[route ?? url.split("?")[0]]?.[method.toLowerCase()]?.responses?.[String(r.statusCode)]?.content?.["application/json"]?.schema;
  if (schema && !ajv.validate(schema, r.json())) throw new Error(`${method} ${url} ${r.statusCode} breaks its OpenAPI schema: ${ajv.errorsText()}`);
  return r;
}
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

beforeAll(async () => {
  await migrate();
  await seed(undefined, true);
  hub = new Hub(MQTT_URL, USER, PASS);
  app = await build({ logger: false, rateLimit: 600, hub });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
  spec = app.swagger() as unknown as typeof spec;
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

let projectId = "";
describe("projects, assets and the OpenAPI contract", () => {
  it("documents the blueprint's endpoints in OpenAPI 3.1", () => {
    expect((app.swagger() as { openapi: string }).openapi).toBe("3.1.0");
    for (const p of ["/v1/projects", "/v1/projects/{id}/assets", "/v1/assets/{id}/transform", "/v1/connectors", "/v1/bindings", "/v1/projects/{id}/branches", "/v1/branches/{id}/simulate", "/v1/branches/{id}/optimize", "/v1/branches/{id}/merge", "/v1/assets/{id}/timeseries"])
      expect(Object.keys(spec.paths)).toContain(p);
  });
  it("creates a project idempotently; viewers and anonymous callers cannot", async () => {
    const h = { ...E, ...key() };
    const a = await call("POST", "/v1/projects", h, { name: "Plant 7 line A", template: "demo" });
    expect(a.statusCode).toBe(201);
    projectId = a.json().id;
    const b = await call("POST", "/v1/projects", h, { name: "Plant 7 line A", template: "demo" });
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json().id).toBe(projectId);
    expect((await call("POST", "/v1/projects", h, { name: "different" })).statusCode).toBe(409);
    expect((await call("POST", "/v1/projects", { ...V, ...key() }, { name: "x" })).statusCode).toBe(403);
    expect((await call("POST", "/v1/projects", key(), { name: "x" })).statusCode).toBe(401);
    expect((await call("POST", "/v1/projects", E, { name: "x" })).statusCode).toBe(400); // no Idempotency-Key
    const g = await call("GET", `/v1/projects/${projectId}`, V, undefined, "/v1/projects/{id}");
    expect(g.json().branches[0].scene.assets).toHaveLength(8);
  });
  it("adds assets with the editor's validation, moves them, links them", async () => {
    const asset = newAsset("machine", "m1b", [-7, 0, 3.5], "CNC mill M1b");
    expect((await call("POST", `/v1/projects/${projectId}/assets`, { ...E, ...key() }, { branch: "production", asset: { ...asset, type: "laser" } }, "/v1/projects/{id}/assets")).statusCode).toBe(400);
    expect((await call("POST", `/v1/projects/${projectId}/assets`, { ...E, ...key() }, { branch: "production", asset: { ...asset, props: { processS: "fast" } } }, "/v1/projects/{id}/assets")).statusCode).toBe(400);
    expect((await call("POST", `/v1/projects/${projectId}/assets`, { ...E, ...key() }, { branch: "production", asset: { ...asset, id: "bad id!" } }, "/v1/projects/{id}/assets")).statusCode).toBe(400);
    const r = await call("PATCH", "/v1/assets/m1/transform", { ...E, ...key() }, { projectId, position: [-7, 0, 0.5], rotation: [0, 15, 0] }, "/v1/assets/{id}/transform");
    expect(r.statusCode).toBe(200);
    expect(r.json().transform.rotation).toEqual([0, 15, 0]);
    expect((await call("PATCH", "/v1/assets/m1/transform", { ...E, ...key() }, { projectId, scale: [0, 1, 1] }, "/v1/assets/{id}/transform")).statusCode).toBe(400);
    expect((await call("PATCH", "/v1/assets/ghost/transform", { ...E, ...key() }, { projectId, position: [0, 0, 0] }, "/v1/assets/{id}/transform")).statusCode).toBe(404);
    expect((await call("POST", `/v1/projects/${projectId}/links`, { ...E, ...key() }, { from: "m1", to: "nope" }, "/v1/projects/{id}/links")).statusCode).toBe(400);
    expect((await call("POST", `/v1/projects/${projectId}/ops`, { ...E, ...key() }, { op: { kind: "set", id: "m1", field: "__proto__", value: 1 } }, "/v1/projects/{id}/ops")).statusCode).toBe(400);
  });
});

describe("tenant isolation", () => {
  it("another tenant cannot see, edit, branch or stream the project", async () => {
    expect((await call("GET", `/v1/projects/${projectId}`, G, undefined, "/v1/projects/{id}")).statusCode).toBe(404);
    expect((await call("PATCH", "/v1/assets/m1/transform", { ...G, ...key() }, { projectId, position: [0, 0, 0] }, "/v1/assets/{id}/transform")).statusCode).toBe(404);
    expect((await call("POST", `/v1/projects/${projectId}/branches`, { ...G, ...key() }, { id: "steal", name: "steal", parentId: "production" }, "/v1/projects/{id}/branches")).statusCode).toBe(404);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/projects/${projectId}/telemetry?token=globex-engineer-demo`);
    const m = await new Promise<{ error?: { code: string } }>((ok) => ws.on("message", (d) => ok(JSON.parse(String(d)))));
    expect(m.error?.code).toBe("not_found");
  });
  it("row-level security holds for a query with no WHERE clause, and an emptied tenant setting is not an error", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://forge_app:app-dev-only@127.0.0.1:55520/forge" });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM twin_projects")).rows[0].n).toBe(0);
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', (SELECT id::text FROM organizations WHERE slug='acme'), true)"); await c.query("COMMIT");
    expect((await c.query("SELECT current_setting('app.tenant', true) s")).rows[0].s).toBe("");
    expect((await c.query("SELECT count(*)::int n FROM assets")).rows[0].n).toBe(0);
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', (SELECT id::text FROM organizations WHERE slug='globex'), true)");
    await expect(c.query("INSERT INTO comments (id, project_id, tenant_id, author, position, text) SELECT 'x', id, tenant_id, 'g', '[0,0,0]', 'hi' FROM twin_projects")).resolves.toMatchObject({ rowCount: 0 });
    await expect(c.query(`INSERT INTO comments (id, project_id, tenant_id, author, position, text) VALUES ('y', '${projectId}', (SELECT id FROM organizations WHERE slug='acme'), 'g', '[0,0,0]', 'hi')`)).rejects.toThrow(/row-level security/);
    await c.query("ROLLBACK"); await c.end();
  });
});

describe("connectors: OT credentials never reach the browser", () => {
  it("encrypts the config, returns only a label, and never echoes the secret anywhere", async () => {
    const secret = "s3cret-OT-password-for-test";
    const r = await call("POST", "/v1/connectors", { ...E, ...key() }, { projectId, connectorType: "mqtt", config: { url: "mqtt://broker.plant.local:1883", username: "plc", password: secret } });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain(secret);
    expect(r.body).not.toContain("plc");
    const list = await call("GET", `/v1/connectors?projectId=${projectId}`, V);
    expect(list.body).not.toContain(secret);
    const own = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL ?? "postgresql://forge:owner-dev-only@127.0.0.1:55520/forge" });
    await own.connect();
    const row = (await own.query("SELECT config_encrypted FROM connectors WHERE id = $1", [r.json().id])).rows[0];
    await own.end();
    expect(Buffer.from(row.config_encrypted).toString("utf8")).not.toContain(secret);
    expect(decrypt<{ password: string }>(Buffer.from(row.config_encrypted)).password).toBe(secret);
    // the demo preset uses the platform's own credentials: the browser sends none
    const pre = await call("POST", "/v1/connectors", { ...E, ...key() }, { projectId, connectorType: "mqtt", preset: "demo-broker" });
    expect(pre.body).not.toContain(PASS);
    // and the static site bundle carries no broker password
    const out = new URL("../../web/out/", import.meta.url).pathname;
    if (existsSync(out)) {
      const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? files(`${d}/${f}`) : [`${d}/${f}`]));
      for (const f of files(out).filter((f) => /\.(js|html|json)$/.test(f))) expect(readFileSync(f, "utf8").includes(PASS)).toBe(false);
    }
  });
  it("binding transforms are validated: no code, real assets only", async () => {
    const b = { projectId, id: "bind-m1-rpm", assetId: "m1", sourcePath: "forge/demo/m1/rpm", targetProperty: "spindleRpm", transform: "value / 1" };
    expect((await call("POST", "/v1/bindings", { ...E, ...key() }, b)).statusCode).toBe(201);
    expect((await call("POST", "/v1/bindings", { ...E, ...key() }, { ...b, transform: "process.exit()" })).json().error.code).toBe("invalid_request");
    expect((await call("POST", "/v1/bindings", { ...E, ...key() }, { ...b, assetId: "ghost" })).statusCode).toBe(404);
    expect((await call("POST", "/v1/bindings", { ...E, ...key() }, { ...b, targetProperty: "eval" })).statusCode).toBe(400);
  });
});

describe("telemetry", () => {
  it("the MQTT connector passes the connector contract against Mosquitto (cut and restored through a TCP proxy)", async () => {
    const [host, bport] = MQTT_URL.replace("mqtt://", "").split(":");
    const socks = new Set<net.Socket>();
    let server: net.Server;
    const listen = (p: number) => new Promise<number>((ok) => {
      server = net.createServer((c) => { const up = net.connect(Number(bport), host); socks.add(c); socks.add(up); c.pipe(up).pipe(c); const kill = () => { c.destroy(); up.destroy(); }; c.on("error", kill); up.on("error", kill); c.on("close", kill); });
      server.listen(p, "127.0.0.1", () => ok((server.address() as net.AddressInfo).port));
    });
    const proxyPort = await listen(0);
    const pub = mqtt.connect(MQTT_URL, { username: USER, password: PASS });
    await new Promise((ok) => pub.on("connect", ok));
    await connectorContract({
      make: () => new MqttConnector(`mqtt://127.0.0.1:${proxyPort}`, USER, PASS),
      publish: (r: Reading) => new Promise<void>((ok) => pub.publish(r.topic, JSON.stringify(r), { retain: true }, () => ok())),
      cut: () => new Promise<void>((ok) => { server.close(() => ok()); for (const s of socks) s.destroy(); socks.clear(); }),
      restore: async () => { await listen(proxyPort); },
      wait,
    });
    pub.end(true); server!.close();
  }, 60_000);
  it("relays plant telemetry over WebSocket, in batches, with the broker status", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/projects/${projectId}/telemetry?token=acme-viewer-demo`);
    const got: Reading[] = []; const status: string[] = [];
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.status) status.push(m.status); for (const r of m.readings ?? []) got.push(r); });
    await new Promise((ok) => ws.on("open", ok));
    const pub = mqtt.connect(MQTT_URL, { username: USER, password: PASS });
    await new Promise((ok) => pub.on("connect", ok));
    for (let i = 0; i < 50; i++) pub.publish("forge/demo/m1/rpm", JSON.stringify({ topic: "forge/demo/m1/rpm", ts: Date.now() + i, value: 3000 + i, unit: "rpm" }));
    for (let i = 0; i < 30 && !got.some((r) => r.value === 3049); i++) await wait(100);
    expect(got.some((r) => r.value === 3049)).toBe(true);
    expect(got.filter((r) => r.topic === "forge/demo/m1/rpm").length).toBeLessThan(50); // coalesced per topic between flushes
    expect(status[0]).toBe("ok");
    // the lab outage reaches clients as a status change, and the hub comes back
    expect((await call("POST", "/v1/lab/broker-outage", { ...E, ...key() }, { ms: 800 })).statusCode).toBe(200);
    for (let i = 0; i < 20 && !status.includes("broker-down"); i++) await wait(100);
    expect(status).toContain("broker-down");
    for (let i = 0; i < 80 && status.at(-1) !== "ok"; i++) await wait(100);
    expect(status.at(-1)).toBe("ok");
    ws.close(); pub.end(true);
  }, 30_000);
  it("stores latest values for projects with a connector and serves the time series", async () => {
    const pub = mqtt.connect(MQTT_URL, { username: USER, password: PASS });
    await new Promise((ok) => pub.on("connect", ok));
    // a test-only asset, so the Docker plant simulator (if running on the same broker) cannot overwrite the value
    pub.publish("forge/demo/mtest/temperature", JSON.stringify({ topic: "forge/demo/mtest/temperature", ts: Date.now(), value: 61.5, unit: "°C" }));
    let pts: { value: number }[] = [];
    for (let i = 0; i < 40 && !pts.length; i++) { await wait(150); pts = (await call("GET", `/v1/assets/mtest/timeseries?projectId=${projectId}&metric=temperature`, V, undefined, "/v1/assets/{id}/timeseries")).json().points; }
    expect(pts[0].value).toBe(61.5);
    pub.end(true);
  }, 20_000);
});

describe("branches, simulation, merge, collaboration", () => {
  it("branches, simulates, compares with common random numbers, sizes a buffer and merges", async () => {
    expect((await call("POST", `/v1/projects/${projectId}/branches`, { ...E, ...key() }, { id: "expansion", name: "expansion", parentId: "production" }, "/v1/projects/{id}/branches")).statusCode).toBe(201);
    expect((await call("POST", `/v1/projects/${projectId}/branches`, { ...E, ...key() }, { id: "expansion", name: "again", parentId: "production" }, "/v1/projects/{id}/branches")).statusCode).toBe(409);
    await call("POST", `/v1/projects/${projectId}/assets`, { ...E, ...key() }, { branch: "expansion", asset: newAsset("machine", "m1b", [-7, 0, 3.5], "CNC mill M1b"), clock: 100, actor: "ana" }, "/v1/projects/{id}/assets");
    for (const [from, to] of [["c1", "m1b"], ["m1b", "b1"]]) await call("POST", `/v1/projects/${projectId}/links`, { ...E, ...key() }, { branch: "expansion", from, to }, "/v1/projects/{id}/links");
    const sim = await call("POST", `/v1/branches/expansion/simulate?projectId=${projectId}`, E, { reps: 10 }, "/v1/branches/{id}/simulate");
    expect(sim.statusCode).toBe(200);
    expect(sim.json().kpis.throughputPerH.mean).toBeGreaterThan(65);
    expect(sim.json().playback.moves.length).toBeGreaterThan(100);
    const cmp = await call("POST", `/v1/branches/expansion/simulate?projectId=${projectId}`, E, { reps: 10, compareTo: { branch: "production" } }, "/v1/branches/{id}/simulate");
    expect(cmp.json().significant).toBe(true);
    expect(cmp.json().throughputDiff.lo).toBeGreaterThan(5);
    expect((await call("POST", `/v1/branches/expansion/simulate?projectId=${projectId}`, V, { reps: 10 }, "/v1/branches/{id}/simulate")).statusCode).toBe(403);
    const opt = await call("POST", `/v1/branches/production/optimize?projectId=${projectId}`, E, { bufferId: "b1", projectId }, "/v1/branches/{id}/optimize");
    expect(opt.json().rows).toHaveLength(9);
    expect((await call("POST", `/v1/branches/production/optimize?projectId=${projectId}`, E, { bufferId: "m1", projectId }, "/v1/branches/{id}/optimize")).statusCode).toBe(400);
    // a conflicting edit on production, then the merge
    await call("PATCH", "/v1/assets/b1/transform", { ...E, ...key() }, { projectId, branch: "expansion", rotation: [0, 30, 0], clock: 200, actor: "ana" }, "/v1/assets/{id}/transform");
    await call("PATCH", "/v1/assets/b1/transform", { ...E, ...key() }, { projectId, branch: "production", rotation: [0, 45, 0], clock: 201, actor: "ben" }, "/v1/assets/{id}/transform");
    const m = await call("POST", "/v1/branches/expansion/merge", { ...E, ...key() }, { projectId }, "/v1/branches/{id}/merge");
    expect(m.statusCode).toBe(200);
    expect(m.json().conflicts).toEqual([{ id: "b1", field: "rotation", ours: [0, 45, 0], theirs: [0, 30, 0] }]);
    const prod = (await call("GET", `/v1/projects/${projectId}`, E, undefined, "/v1/projects/{id}")).json().branches.find((b: { id: string }) => b.id === "production").scene;
    expect(prod.assets.some((a: { id: string }) => a.id === "m1b")).toBe(true);
    expect(prod.links).toContainEqual({ from: "c1", to: "m1b" });
    expect(prod.assets.find((a: { id: string }) => a.id === "b1").transform.rotation).toEqual([0, 45, 0]);
    expect((await call("POST", "/v1/branches/production/merge", { ...E, ...key() }, { projectId }, "/v1/branches/{id}/merge")).statusCode).toBe(400);
  }, 60_000);
  it("relays collaboration messages between two clients and persists comments; viewers cannot edit", async () => {
    const open = (tok: string, actor: string) => new Promise<WebSocket>((ok) => { const w = new WebSocket(`ws://127.0.0.1:${port}/v1/projects/${projectId}/presence?token=${tok}&actor=${actor}`); w.on("open", () => ok(w)); });
    const a = await open("acme-engineer-demo", "ana"), b = await open("acme-engineer-demo", "ben"), v = await open("acme-viewer-demo", "vic");
    const atB: { kind: string }[] = [];
    b.on("message", (d) => atB.push(JSON.parse(String(d))));
    await wait(300); // sockets join their room once the token is checked
    a.send(JSON.stringify({ kind: "presence", presence: { actor: "ana", name: "Ana", color: "#fff", point: [1, 0, 2], selected: null, at: Date.now() } }));
    a.send(JSON.stringify({ kind: "comment", comment: { id: "c-test-1", author: "Ana", assetId: "m1", position: [-7, 0.1, 1], text: "Check the aisle width." } }));
    v.send(JSON.stringify({ kind: "op", branch: "production", op: { kind: "remove", id: "m1", clock: 9e12, actor: "vic" } }));
    for (let i = 0; i < 20 && atB.length < 2; i++) await wait(50);
    await wait(150);
    expect(atB.map((m) => m.kind)).toEqual(["presence", "comment"]);
    const cs = await call("GET", `/v1/projects/${projectId}/comments`, V, undefined, "/v1/projects/{id}/comments");
    expect(cs.json().items.map((c: { text: string }) => c.text)).toContain("Check the aisle width.");
    a.close(); b.close(); v.close();
  });
});

describe("operations", () => {
  it("keeps a valid hash-chained audit log per tenant", async () => {
    const r = await call("GET", "/v1/audit", E);
    expect(r.json().chainValid).toBe(true);
    expect(r.json().items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["project.create", "connector.create", "branch.create", "branch.merge"]));
    expect((await call("GET", "/v1/audit", G)).json().items).toHaveLength(0);
  });
  it("propagates trace ids, reports RED metrics, rate-limits with headers", async () => {
    const tp = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const r = await app.inject({ method: "GET", url: "/v1/templates/demo", headers: { traceparent: tp } });
    expect(String(r.headers.traceparent)).toContain("0123456789abcdef0123456789abcdef");
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toMatch(/forge_request_latency_ms\{route="POST \/v1\/projects",quantile="0.95"\}/);
    expect(m.body).toMatch(/forge_broker_up 1/);
    const small = await build({ logger: false, rateLimit: 5, hub: null });
    let last = 200;
    for (let i = 0; i < 20 && last !== 429; i++) last = (await small.inject({ method: "GET", url: "/v1/templates/demo", headers: V })).statusCode;
    expect(last).toBe(429);
    await small.close();
  });
});
