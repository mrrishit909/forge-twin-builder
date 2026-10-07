// Backends behind one interface. The public sandbox (StaticBackend) runs everything in the browser: an in-memory MQTT-like
// broker fed by the plant simulator, the simulation worker, and BroadcastChannel between tabs for collaboration. The Docker
// build (ApiBackend, NEXT_PUBLIC_API_URL) uses the real API: Mosquitto telemetry relayed over WebSocket, server-side
// simulation, persisted assets, branches, connectors (credentials encrypted, never returned) and comments.
import { PlantSim, SimBroker, SimConnector, DEMO_MACHINES, backoffMs, parseScene, type Binding, type ConnState, type Connector, type Reading, type Scene, type Comment, type Op, type Link, type Presence } from "@forge/domain";
import { traceparent } from "@forge/telemetry";
import { SimClient } from "./worker/client.ts";
import type { FromWorker } from "./worker/protocol.ts";

export type CollabMsg =
  | { kind: "hello"; actor: string }
  | { kind: "snapshot"; to: string; state: unknown }
  | { kind: "op"; branch: string; op: Op }
  | { kind: "link"; branch: string; link: Link }
  | { kind: "binding"; branch: string; binding: Binding }
  | { kind: "branch"; branch: { id: string; name: string; parentId: string | null; base: Scene; createdBy: string; createdAt: string } }
  | { kind: "comment"; comment: Comment }
  | { kind: "presence"; presence: Presence };

export interface Collab { send(m: CollabMsg): void; onMessage(cb: (m: CollabMsg) => void): () => void; close(): void }
export type SimOut = Extract<FromWorker, { type: "simulate" }>;
export type CompareOut = Extract<FromWorker, { type: "compare" }>;
export type OptimizeOut = Extract<FromWorker, { type: "optimize" }>;
export interface ConnectorInfo { id: string; type: string; status: string; label: string }

export interface Backend {
  readonly kind: "static" | "api";
  loadTemplate(): Promise<Scene>;
  createProject(name: string, scene: Scene): Promise<{ id: string }>;
  /** the project's branches as stored (API), or null when peers must send it (static sandbox) */
  loadProject(id: string): Promise<{ id: string; name: string; branches: { id: string; name: string; parentId: string | null; scene: Scene }[] } | null>;
  persistOp(projectId: string, branch: string, op: Op): Promise<void>;
  createBranch(projectId: string, id: string, name: string, parentId: string): Promise<void>;
  persistLink(projectId: string, branch: string, link: Link): Promise<void>;
  createConnector(projectId: string): Promise<ConnectorInfo>;
  bind(projectId: string, b: Binding): Promise<void>;
  connector(projectId: string): Connector;
  simulate(branch: string, scene: Scene): Promise<SimOut>;
  compare(base: Scene, branch: Scene, ids: [string, string]): Promise<CompareOut>;
  optimize(branch: string, scene: Scene, bufferId: string): Promise<OptimizeOut>;
  collab(projectId: string, actor: string): Collab;
  /** failure lab hooks (the static backend drives its simulated plant; the API backend asks the server) */
  lab: { dropBroker(ms: number): void; storm(n: number): void; injectFault(machine: string): void };
}

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const sim = new SimClient();

/** In-browser plant: the simulator publishes to the in-memory broker at `warp` simulated seconds per real second. */
class StaticPlant {
  broker = new SimBroker();
  plant = new PlantSim("demo", DEMO_MACHINES.map((m) => ({ ...m, faultAtS: null })), 42);
  private iv: ReturnType<typeof setInterval> | null = null;
  private t0 = Date.parse("2026-10-06T08:00:00Z");
  start(warp = 20) {
    if (this.iv) return;
    this.iv = setInterval(() => { for (let k = 0; k < warp; k++) this.plant.tick(this.t0, (r) => this.broker.publish(r)); }, 1000);
    this.plant.tick(this.t0, (r) => this.broker.publish(r));
  }
}

export class StaticBackend implements Backend {
  readonly kind = "static" as const;
  private plant = new StaticPlant();
  async loadTemplate() {
    const r = await fetch(`${base}/data/template-scene.json`, { headers: { traceparent: traceparent() } });
    if (!r.ok) throw new Error(`template scene: HTTP ${r.status}`);
    return parseScene(await r.text());
  }
  async createProject(_name: string) { return { id: "demo" }; }
  async loadProject() { return null; }
  async persistOp() {}
  async createBranch() {}
  async persistLink() {}
  async createConnector(): Promise<ConnectorInfo> { return { id: "sim-mqtt", type: "mqtt", status: "simulated", label: "Simulated MQTT broker (in this browser)" }; }
  async bind() {}
  connector(): Connector { this.plant.start(); return new SimConnector(this.plant.broker); }
  async simulate(_b: string, scene: Scene) { return sim.call<"simulate">({ type: "simulate", scene, reps: 30 }); }
  async compare(a: Scene, b: Scene) { return sim.call<"compare">({ type: "compare", base: a, branch: b, reps: 30 }); }
  async optimize(_b: string, scene: Scene, bufferId: string) { return sim.call<"optimize">({ type: "optimize", scene, bufferId }); }
  collab(projectId: string, actor: string): Collab {
    const ch = typeof BroadcastChannel === "function" ? new BroadcastChannel(`forge-${projectId}`) : null;
    const subs = new Set<(m: CollabMsg) => void>();
    if (ch) ch.onmessage = (e) => { for (const s of subs) s(e.data); };
    return { send: (m) => ch?.postMessage(m), onMessage: (cb) => { subs.add(cb); return () => subs.delete(cb); }, close: () => ch?.close() };
    void actor;
  }
  lab = {
    dropBroker: (ms: number) => { this.plant.broker.cut(); setTimeout(() => this.plant.broker.restore(), ms); },
    storm: (n: number) => { for (let i = 0; i < n; i++) this.plant.broker.publish({ topic: `forge/demo/storm/${i % 2000}`, ts: Date.now(), value: i, unit: "" }); },
    injectFault: (machine: string) => { const s = this.plant.plant.sims.find((x) => x.m.id === machine); if (s) s.m.faultAtS = s.seconds; },
  };
}

/** WebSocket connector to the API's telemetry relay (which subscribes to Mosquitto). Reconnects with jittered backoff. */
export class WsConnector implements Connector {
  readonly kind = "mqtt-via-api";
  state: ConnState = "idle";
  private ws: WebSocket | null = null;
  private subs = new Set<{ filter: string; cb: (r: Reading) => void }>();
  private listeners = new Set<(s: ConnState, info?: string) => void>();
  private attempts = 0;
  private url: string;
  constructor(url: string) { this.url = url; }
  private set(s: ConnState, info?: string) { this.state = s; for (const l of this.listeners) l(s, info); }
  async connect() {
    this.set("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.attempts = 0; this.set("connected"); };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.status) { this.set(m.status === "broker-down" ? "backoff" : "connected", m.info); return; } for (const r of (m.readings ?? [m]) as Reading[]) for (const s of this.subs) if (r.topic.startsWith(s.filter.replace(/[#+].*$/, ""))) s.cb(r); };
    ws.onclose = () => { if (this.state === "closed") return; const ms = backoffMs(this.attempts++, Math.random); this.set("backoff", `connection lost; retry ${this.attempts} in ${ms} ms`); setTimeout(() => { if (this.state !== "closed") this.connect(); }, ms); };
  }
  subscribe(filter: string, cb: (r: Reading) => void) { const s = { filter, cb }; this.subs.add(s); return () => { this.subs.delete(s); }; }
  onState(cb: (s: ConnState, info?: string) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async close() { this.set("closed"); this.ws?.close(); }
}

export class ApiBackend implements Backend {
  readonly kind = "api" as const;
  private url: string; private token: string;
  constructor(url: string, token: string) { this.url = url; this.token = token; }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, traceparent: traceparent() };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
    const r = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json();
    if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
    return j as T;
  }
  async loadTemplate() { return parseScene((await this.req<{ scene: Scene }>("GET", "/v1/templates/demo")).scene); }
  async createProject(name: string) { return this.req<{ id: string }>("POST", "/v1/projects", { name, template: "demo" }); }
  async loadProject(id: string) { const p = await this.req<{ id: string; name: string; branches: { id: string; name: string; parentId: string | null; scene: Scene }[] }>("GET", `/v1/projects/${id}`); return { ...p, branches: p.branches.map((b) => ({ ...b, scene: parseScene(b.scene) })) }; }
  async persistOp(projectId: string, branch: string, op: Op) {
    if (op.kind === "add") await this.req("POST", `/v1/projects/${projectId}/assets`, { branch, asset: op.asset, clock: op.clock, actor: op.actor });
    else if (op.kind === "set" && (op.field === "position" || op.field === "rotation" || op.field === "scale")) await this.req("PATCH", `/v1/assets/${op.id}/transform`, { projectId, branch, [op.field]: op.value, clock: op.clock, actor: op.actor });
    else await this.req("POST", `/v1/projects/${projectId}/ops`, { branch, op });
  }
  async createBranch(projectId: string, id: string, name: string, parentId: string) { await this.req("POST", `/v1/projects/${projectId}/branches`, { id, name, parentId }); }
  async persistLink(projectId: string, branch: string, link: Link) { await this.req("POST", `/v1/projects/${projectId}/links`, { branch, ...link }); }
  async createConnector(projectId: string) {
    // the platform holds the broker credentials (the "demo-broker" preset); the browser never sees an OT secret
    return this.req<ConnectorInfo>("POST", "/v1/connectors", { projectId, connectorType: "mqtt", preset: "demo-broker" });
  }
  async bind(projectId: string, b: Binding) { await this.req("POST", "/v1/bindings", { projectId, ...b }); }
  connector(projectId: string): Connector { return new WsConnector(`${this.url.replace(/^http/, "ws")}/v1/projects/${projectId}/telemetry?token=${this.token}`); }
  async simulate(branch: string, scene: Scene) { return this.req<SimOut>("POST", `/v1/branches/${branch}/simulate`, { scene }); }
  async compare(a: Scene, b: Scene, ids: [string, string]) { return this.req<CompareOut>("POST", `/v1/branches/${ids[1]}/simulate`, { scene: b, compareTo: { branch: ids[0], scene: a } }); }
  async optimize(branch: string, scene: Scene, bufferId: string) { return this.req<OptimizeOut>("POST", `/v1/branches/${branch}/optimize`, { scene, bufferId }); }
  collab(projectId: string, actor: string): Collab {
    const subs = new Set<(m: CollabMsg) => void>();
    let ws: WebSocket | null = null, closed = false;
    const queue: CollabMsg[] = [];
    const open = () => {
      ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/v1/projects/${projectId}/presence?token=${this.token}&actor=${encodeURIComponent(actor)}`);
      ws.onopen = () => { while (queue.length) ws!.send(JSON.stringify(queue.shift())); };
      ws.onmessage = (e) => { const m = JSON.parse(e.data); for (const s of subs) s(m); };
      ws.onclose = () => { if (!closed) setTimeout(open, 1000); };
    };
    open();
    return {
      send: (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); else queue.push(m); },
      onMessage: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      close: () => { closed = true; ws?.close(); },
    };
  }
  lab = {
    dropBroker: (ms: number) => { void this.req("POST", "/v1/lab/broker-outage", { ms }); },
    storm: (n: number) => { void this.req("POST", "/v1/lab/storm", { n }); },
    injectFault: (machine: string) => { void this.req("POST", "/v1/lab/fault", { machine }); },
  };
}

export function makeBackend(): Backend {
  const api = process.env.NEXT_PUBLIC_API_URL;
  return api ? new ApiBackend(api, process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "acme-engineer-demo") : new StaticBackend();
}
