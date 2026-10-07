// Typed client for the FORGE API (shapes match docs/openapi.json): bearer token, a W3C traceparent per call, an
// Idempotency-Key on every mutation, error bodies as ApiError.
import type { Asset, Binding, Estimate, Kpis, Link, Op, Scene, SimResult, Conflict } from "@forge/domain";

export class ApiError extends Error {
  status: number; code: string; traceId?: string;
  constructor(status: number, code: string, message: string, traceId?: string) { super(message); this.status = status; this.code = code; this.traceId = traceId; }
}
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class ForgeClient {
  private base: string; private token?: string;
  constructor(base: string, token?: string) { this.base = base.replace(/\/$/, ""); this.token = token; }
  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { traceparent: `00-${hex(16)}-${hex(8)}-01` };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText, j?.error?.traceId);
    return j as T;
  }
  template() { return this.req<{ scene: Scene }>("GET", "/v1/templates/demo"); }
  createProject(name: string, template: "demo" | "empty" = "demo", key?: string) { return this.req<{ id: string; name: string; branches: string[] }>("POST", "/v1/projects", { name, template }, key); }
  project(id: string) { return this.req<{ id: string; name: string; branches: { id: string; name: string; parentId: string | null; scene: Scene }[] }>("GET", `/v1/projects/${id}`); }
  addAsset(projectId: string, asset: Asset, branch = "production") { return this.req<{ id: string }>("POST", `/v1/projects/${projectId}/assets`, { branch, asset }); }
  transform(projectId: string, assetId: string, t: { position?: number[]; rotation?: number[]; scale?: number[] }, branch = "production") { return this.req<{ id: string; transform: Asset["transform"] }>("PATCH", `/v1/assets/${assetId}/transform`, { projectId, branch, ...t }); }
  op(projectId: string, op: Op, branch = "production") { return this.req("POST", `/v1/projects/${projectId}/ops`, { branch, op }); }
  link(projectId: string, link: Link, branch = "production") { return this.req("POST", `/v1/projects/${projectId}/links`, { branch, ...link }); }
  connector(projectId: string, body: { connectorType: "mqtt" | "rest"; preset?: "demo-broker"; config?: { url: string; username?: string; password?: string } }) { return this.req<{ id: string; type: string; status: string; label: string }>("POST", "/v1/connectors", { projectId, ...body }); }
  bind(projectId: string, b: Binding) { return this.req<{ id: string }>("POST", "/v1/bindings", { projectId, ...b }); }
  timeseries(projectId: string, assetId: string, metric: "rpm" | "temperature" | "vibration") { return this.req<{ points: { ts: string; value: number }[] }>("GET", `/v1/assets/${assetId}/timeseries?projectId=${projectId}&metric=${metric}`); }
  branch(projectId: string, id: string, name: string, parentId: string) { return this.req("POST", `/v1/projects/${projectId}/branches`, { id, name, parentId }); }
  simulate(projectId: string, branch: string, body: { scene?: Scene; reps?: number } = {}) { return this.req<{ kpis: Kpis; playback: SimResult; ms: number }>("POST", `/v1/branches/${branch}/simulate?projectId=${projectId}`, body); }
  compare(projectId: string, branch: string, against: string, reps = 30) { return this.req<{ base: Kpis; branch: Kpis; throughputDiff: Estimate; significant: boolean }>("POST", `/v1/branches/${branch}/simulate?projectId=${projectId}`, { reps, compareTo: { branch: against } }); }
  optimize(projectId: string, branch: string, bufferId: string) { return this.req<{ rows: { capacity: number; throughputPerH: number }[]; chosen: number }>("POST", `/v1/branches/${branch}/optimize?projectId=${projectId}`, { projectId, bufferId }); }
  merge(projectId: string, branch: string) { return this.req<{ applied: number; conflicts: Conflict[]; into: string }>("POST", `/v1/branches/${branch}/merge`, { projectId }); }
}
