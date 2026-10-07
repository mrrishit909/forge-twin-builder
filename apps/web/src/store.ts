// Application state (the source of truth). The scene of each branch is a Replica (collab ops, last-writer-wins per field);
// animation reads from here and from live.ts and never writes business state except through these actions.
import { useSyncExternalStore } from "react";
import {
  Replica, snapTransform, snapToConnector, newAsset, merge as merge3, diff, LIBRARY, compile, ExprError, topicOf,
  type Asset, type AssetType, type Binding, type Comment, type ConnState, type Connector, type Link, type Op, type OpInput, type Presence, type Scene, type Transform, type V3, type Conflict,
} from "@forge/domain";
import { makeBackend, type Collab, type CollabMsg, type CompareOut, type ConnectorInfo, type OptimizeOut, type SimOut } from "./backend.ts";
import { next, type JourneyEvent, type View } from "./journey.ts";
import { ingest, resetLive, setBindings } from "./live.ts";

export interface BranchState { id: string; name: string; parentId: string | null; base: Scene; createdBy: string; createdAt: string; replica: Replica; ops: Op[]; links: Link[]; bindings: Binding[] }

export interface AppState {
  view: View;
  template: Scene | null;
  project: { id: string; name: string } | null;
  branches: BranchState[];
  scenes: Record<string, Scene>;
  active: string;
  selected: string | null;
  tool: "translate" | "rotate" | "scale";
  placing: AssetType | null;
  commentMode: boolean;
  connector: { info: ConnectorInfo | null; state: ConnState; detail?: string };
  sims: Record<string, SimOut>;
  comparison: CompareOut | null;
  optimize: (OptimizeOut & { bufferId: string }) | null;
  busy: string | null;
  mergeResult: { conflicts: Conflict[]; applied: number } | null;
  comments: Comment[];
  presence: Record<string, Presence>;
  me: { actor: string; name: string; color: string };
  alerts: { id: string; text: string; at: number }[];
  load: { status: "idle" | "loading" | "ready" | "error"; message?: string };
  listView: boolean; reduced: boolean; motionPaused: boolean; hud: boolean; palette: boolean; help: boolean; stress: boolean;
  webgl: "ok" | "lost" | "unsupported";
  announce: string;
  error: string | null;
  bookmark: string;
  pendingComment: { position: V3; assetId: string | null } | null;
  stressInfo: { near: number; far: number } | null;
}

const COLORS = ["#5ef2c2", "#ffb454", "#c792ff", "#7fb2ff", "#ff7a59"];
const initial: AppState = {
  view: "intro0", template: null, project: null, branches: [], scenes: {}, active: "production", selected: null, tool: "translate", placing: null, commentMode: false,
  connector: { info: null, state: "idle" }, sims: {}, comparison: null, optimize: null, busy: null, mergeResult: null, comments: [], presence: {},
  me: { actor: "you", name: "You", color: COLORS[0] }, alerts: [], load: { status: "idle" },
  listView: false, reduced: false, motionPaused: false, hud: false, palette: false, help: false, stress: false, webgl: "ok", announce: "", error: null, bookmark: "overview", pendingComment: null, stressInfo: null,
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state), () => sel(initial));
}
export const say = (announce: string) => set({ announce });
export function send(e: JourneyEvent) { set((s) => ({ view: next(s.view, e) })); }

export const backend = makeBackend();
let collab: Collab | null = null;
let connector: Connector | null = null;

// ---------- branches and scenes ----------
const sceneOf = (b: BranchState): Scene => {
  const s = b.replica.scene({ ...b.base, links: b.links, bindings: b.bindings });
  return { ...s, bindings: b.bindings.filter((x) => s.assets.some((a) => a.id === x.assetId)), comments: [] };
};
const DRAFT = "forge-sandbox-draft-v1";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function refresh() {
  set((s) => ({ scenes: Object.fromEntries(s.branches.map((b) => [b.id, sceneOf(b)])) }));
  setBindings(activeScene()?.bindings ?? []);
  // the static sandbox has no server: keep this viewer's draft so a reload or deep link restores the branches
  if (backend.kind === "static" && state.project && state.me.actor === "you") {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(DRAFT, JSON.stringify(snapshot())); } catch { /* storage unavailable */ } }, 300);
  }
}
export function resetDraft() { try { localStorage.removeItem(DRAFT); } catch { /* storage unavailable */ } location.search = "?enter=1"; }
export const activeBranch = () => state.branches.find((b) => b.id === state.active)!;
export const activeScene = (): Scene | undefined => state.scenes[state.active];

function makeBranch(id: string, name: string, parentId: string | null, base: Scene, by: string, at = new Date().toISOString()): BranchState {
  return { id, name, parentId, base: structuredClone(base), createdBy: by, createdAt: at, replica: new Replica(state.me.actor, base), ops: [], links: [...base.links], bindings: [...base.bindings] };
}

/** Apply an op locally (stamped) or from a peer, persist it if it is ours, and broadcast it. */
function applyOp(branchId: string, op: Op | OpInput, remote = false) {
  const b = state.branches.find((x) => x.id === branchId);
  if (!b) return;
  const o: Op = remote ? (op as Op) : b.replica.local(op as OpInput);
  if (remote) b.replica.apply(o);
  if (!b.ops.some((x) => x.actor === o.actor && x.clock === o.clock)) b.ops.push(o);
  if (!remote) { collab?.send({ kind: "op", branch: branchId, op: o }); if (state.project) void backend.persistOp(state.project.id, branchId, o).catch((e) => set({ error: (e as Error).message })); }
}
function addLink(branchId: string, l: Link, remote = false) {
  const b = state.branches.find((x) => x.id === branchId);
  if (!b || b.links.some((x) => x.from === l.from && x.to === l.to)) return;
  b.links.push(l);
  if (!remote) { collab?.send({ kind: "link", branch: branchId, link: l }); if (state.project) void backend.persistLink(state.project.id, branchId, l).catch((e) => set({ error: (e as Error).message })); }
}
/** Manual link (splits and merges, which connector snapping cannot make because a port takes one snap). */
export function linkAssets(from: string, to: string) {
  if (from === to) return;
  addLink(state.active, { from, to });
  refresh();
  const nm = (id: string) => activeScene()?.assets.find((a) => a.id === id)?.name ?? id;
  say(`${nm(from)} now feeds ${nm(to)}.`);
}

// ---------- startup ----------
export async function init(opts: { actor?: string; project?: string }) {
  set({ load: { status: "loading" } });
  try {
    const template = await backend.loadTemplate();
    const actor = opts.actor ?? "you";
    const idx = Math.abs([...actor].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % COLORS.length;
    set({ template, me: { actor, name: actor === "you" ? "You" : actor.replace(/-/g, " "), color: COLORS[idx] }, load: { status: "ready" } });
    if (opts.project) await joinProject(opts.project);
    setInterval(() => { if (state.project) sendPresence(null, true); }, 2000); // heartbeat: people show up before they move
  } catch (e) {
    set({ load: { status: "error", message: (e as Error).message } });
  }
}

function openCollab(projectId: string) {
  collab?.close();
  collab = backend.collab(projectId, state.me.actor);
  collab.onMessage(onCollab);
  collab.send({ kind: "hello", actor: state.me.actor });
}

/** Join an existing project (an invite link): load it from the API, or wait for a peer's snapshot in the static sandbox. */
export async function joinProject(id: string) {
  const p = await backend.loadProject(id);
  if (p) {
    const branches = p.branches.map((b) => makeBranch(b.id, b.name, b.parentId, b.scene, "server"));
    set({ project: { id: p.id, name: p.name }, branches, active: "production" });
    refresh();
    send({ type: "ENTER" });
    say(`Joined ${p.name}.`);
  }
  openCollab(id);
}

export async function createProject(name = "Plant 7 line A") {
  const t = state.template;
  if (!t || state.project) return;
  if (backend.kind === "static" && state.me.actor === "you") {
    let draft: string | null = null;
    try { draft = localStorage.getItem(DRAFT); } catch { /* storage unavailable */ }
    if (draft) { try { loadSnapshot(JSON.parse(draft)); openCollab("demo"); return; } catch { /* corrupt draft: start fresh */ } }
  }
  const { id } = await backend.createProject(name, t);
  const prod = makeBranch("production", "production", null, t, state.me.actor);
  set({ project: { id, name }, branches: [prod], active: "production" });
  openCollab(id);
  refresh();
  send({ type: "ENTER" });
  say(`Project ${name} created from the demo factory template: ${t.assets.length} assets on one line.`);
}

function snapshot() {
  return { project: state.project, branches: state.branches.map((b) => ({ id: b.id, name: b.name, parentId: b.parentId, base: b.base, createdBy: b.createdBy, createdAt: b.createdAt, ops: b.ops, links: b.links, bindings: b.bindings })), comments: state.comments };
}

function loadSnapshot(s: ReturnType<typeof snapshot>) {
  if (!s?.project) return;
  const branches = s.branches.map((b) => {
    const bs = makeBranch(b.id, b.name, b.parentId, b.base, b.createdBy, b.createdAt);
    for (const o of b.ops) { bs.replica.apply(o); bs.ops.push(o); }
    bs.replica.clock = Math.max(bs.replica.clock, ...b.ops.map((o) => o.clock), 0);
    bs.links = [...b.links]; bs.bindings = [...b.bindings];
    return bs;
  });
  set({ project: s.project, branches, comments: s.comments ?? [], active: "production" });
  refresh();
  if (state.view.startsWith("intro")) send({ type: "ENTER" });
  say(`Opened ${s.project.name}.`);
}

function onCollab(m: CollabMsg) {
  if (m.kind === "hello") { if (m.actor !== state.me.actor && state.project) collab?.send({ kind: "snapshot", to: m.actor, state: snapshot() }); return; }
  if (m.kind === "snapshot") {
    if (m.to !== state.me.actor) return;
    loadSnapshot(m.state as ReturnType<typeof snapshot>);
    return;
  }
  if (m.kind === "op") { applyOp(m.branch, m.op, true); refresh(); return; }
  if (m.kind === "link") { addLink(m.branch, m.link, true); refresh(); return; }
  if (m.kind === "binding") { const b = state.branches.find((x) => x.id === m.branch); if (b && !b.bindings.some((x) => x.id === m.binding.id)) { b.bindings.push(m.binding); refresh(); } return; }
  if (m.kind === "branch") {
    if (state.branches.some((b) => b.id === m.branch.id)) return;
    set((s) => ({ branches: [...s.branches, makeBranch(m.branch.id, m.branch.name, m.branch.parentId, m.branch.base, m.branch.createdBy, m.branch.createdAt)] }));
    refresh();
    return;
  }
  if (m.kind === "comment") { if (!state.comments.some((c) => c.id === m.comment.id)) { set((s) => ({ comments: [...s.comments, m.comment] })); say(`${m.comment.author} commented: ${m.comment.text}`); } return; }
  if (m.kind === "presence") set((s) => ({ presence: { ...s.presence, [m.presence.actor]: m.presence } }));
}

// ---------- editing ----------
let seq = 0;
export function addAsset(type: AssetType, at: V3) {
  const sc = activeScene();
  if (!sc) return;
  const id = `${type.slice(0, 3)}-${state.me.actor.slice(0, 4)}-${Date.now().toString(36)}${seq++}`;
  const count = sc.assets.filter((a) => a.type === type).length + 1;
  let a: Asset = newAsset(type, id, at, `${LIBRARY[type].label} ${count}`);
  a.transform = snapTransform(a.transform);
  const hit = snapToConnector(sc, a);
  if (hit) a = { ...a, transform: hit.transform };
  applyOp(state.active, { kind: "add", asset: a });
  if (hit) addLink(state.active, hit.link);
  refresh();
  set({ selected: id, placing: null });
  send({ type: "SELECT" });
  say(`${a.name} placed${hit ? `, connected ${hit.link.from === id ? "to" : "from"} ${sc.assets.find((x) => x.id === (hit.link.from === id ? hit.link.to : hit.link.from))?.name}` : ""}.`);
  return id;
}

/** Commit a gizmo drag: grid/angle/scale snap, then connector snap; only changed fields become ops. */
export function commitTransform(id: string, t: Transform) {
  const sc = activeScene();
  const a = sc?.assets.find((x) => x.id === id);
  if (!sc || !a) return;
  let nt = snapTransform(t);
  const hit = snapToConnector(sc, { ...a, transform: nt });
  if (hit) nt = hit.transform;
  for (const f of ["position", "rotation", "scale"] as const) if (JSON.stringify(nt[f]) !== JSON.stringify(a.transform[f])) applyOp(state.active, { kind: "set", id, field: f, value: nt[f] });
  if (hit) addLink(state.active, hit.link);
  refresh();
}

export function setProp(id: string, key: string, value: number) {
  if (!Number.isFinite(value)) return;
  applyOp(state.active, { kind: "set", id, field: `props.${key}`, value });
  refresh();
}
export function removeAsset(id: string) {
  applyOp(state.active, { kind: "remove", id });
  set({ selected: null });
  refresh();
  send({ type: "DESELECT" });
}
export function select(id: string | null) {
  set({ selected: id });
  if (id) { send({ type: "SELECT" }); const a = activeScene()?.assets.find((x) => x.id === id); if (a) say(`Selected ${a.name}.`); }
  else send({ type: "DESELECT" });
}

// ---------- telemetry ----------
export async function connectTelemetry() {
  if (!state.project || connector) return;
  set({ busy: "Connecting telemetry" });
  try {
    const info = await backend.createConnector(state.project.id);
    connector = backend.connector(state.project.id);
    connector.onState((s, detail) => {
      set((x) => ({ connector: { ...x.connector, state: s, detail } }));
      if (s === "backoff") say(`Telemetry connection lost: ${detail}.`);
      if (s === "connected") say("Telemetry connected.");
    });
    connector.subscribe("forge/demo/#", ingest);
    await connector.connect();
    set({ connector: { info, state: connector.state }, busy: null });
  } catch (e) { set({ busy: null, error: (e as Error).message }); }
}
export const disconnectTelemetry = async () => { await connector?.close(); connector = null; resetLive(); set({ connector: { info: null, state: "idle" } }); };

export const BINDABLE = [
  { metric: "rpm", property: "spindleRpm", label: "RPM → spindle speed", transform: "value" },
  { metric: "temperature", property: "temperatureC", label: "Temperature → heat colour", transform: "clamp(value, 20, 120)" },
  { metric: "vibration", property: "vibration", label: "Vibration → shake and alarm", transform: "value" },
  { metric: "status", property: "status", label: "Status → state light", transform: "value" },
] as const;

/** Bind a telemetry topic to an asset property. The transform is validated by the expression compiler (no code execution). */
export function bind(assetId: string, metric: string, property: string, transform: string): string | null {
  try { compile(transform); } catch (e) { return e instanceof ExprError ? e.message : String(e); }
  const b = activeBranch();
  const binding: Binding = { id: `bind-${assetId}-${property}`, assetId, connectorId: state.connector.info?.id ?? "sim-mqtt", sourcePath: topicOf("demo", assetId, metric as never), targetProperty: property, transform, unit: "" };
  b.bindings = [...b.bindings.filter((x) => x.id !== binding.id), binding];
  collab?.send({ kind: "binding", branch: b.id, binding });
  if (state.project) void backend.bind(state.project.id, binding).catch((e) => set({ error: (e as Error).message }));
  refresh();
  say(`Bound ${metric} of ${assetId} to ${property}.`);
  return null;
}

// ---------- branches, simulation, compare, merge ----------
export function newBranch(name: string) {
  const src = activeBranch(), sc = activeScene();
  if (!src || !sc || !state.project) return;
  const id = name.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 30) || `branch-${state.branches.length}`;
  if (state.branches.some((b) => b.id === id)) { set({ active: id }); refresh(); return; }
  const b = makeBranch(id, name, src.id, sc, state.me.actor);
  set((s) => ({ branches: [...s.branches, b], active: id }));
  collab?.send({ kind: "branch", branch: { id, name, parentId: src.id, base: b.base, createdBy: b.createdBy, createdAt: b.createdAt } });
  void backend.createBranch(state.project.id, id, name, src.id).catch((e) => set({ error: (e as Error).message }));
  refresh();
  say(`Branch ${name} created from ${src.name}.`);
}
export function switchBranch(id: string) { if (state.branches.some((b) => b.id === id)) { set({ active: id, selected: null }); refresh(); } }

export async function simulate() {
  const sc = activeScene();
  if (!sc) return;
  set({ busy: "Simulating 30 shifts" });
  send({ type: "SIMULATE" });
  try {
    const r = await backend.simulate(state.active, sc);
    set((s) => ({ sims: { ...s.sims, [s.active]: r }, busy: null }));
    const k = r.kpis;
    say(`Simulated ${k.runs} shifts: ${k.throughputPerH.mean.toFixed(1)} parts per hour (95% interval ${k.throughputPerH.lo.toFixed(1)} to ${k.throughputPerH.hi.toFixed(1)}).`);
  } catch (e) { set({ busy: null, error: (e as Error).message }); }
}

export async function compareWithProduction() {
  const prod = state.scenes.production, cur = activeScene();
  if (!prod || !cur || state.active === "production") return;
  set({ busy: "Comparing branches (common random numbers)" });
  try {
    const r = await backend.compare(prod, cur, ["production", state.active]);
    set({ comparison: r, busy: null });
    send({ type: "COMPARE" });
    say(`${state.active} vs production: ${r.throughputDiff.mean >= 0 ? "+" : ""}${r.throughputDiff.mean.toFixed(1)} parts per hour (95% interval ${r.throughputDiff.lo.toFixed(1)} to ${r.throughputDiff.hi.toFixed(1)}).`);
  } catch (e) { set({ busy: null, error: (e as Error).message }); }
}

export async function optimizeBuffer(bufferId: string) {
  const sc = activeScene();
  if (!sc) return;
  set({ busy: `Sizing ${bufferId}` });
  try { const r = await backend.optimize(state.active, sc, bufferId); set({ optimize: { ...r, bufferId }, busy: null }); }
  catch (e) { set({ busy: null, error: (e as Error).message }); }
}

/** Three-way merge of the active branch into its parent, applied to the parent as ops so collaborators converge on it too. */
export function mergeIntoParent() {
  const b = activeBranch();
  if (!b?.parentId) return;
  const parent = state.branches.find((x) => x.id === b.parentId)!;
  const r = merge3(b.base, state.scenes[parent.id], state.scenes[b.id]);
  for (const c of diff(state.scenes[parent.id], r.scene)) {
    if (c.kind === "added") applyOp(parent.id, { kind: "add", asset: c.asset });
    else if (c.kind === "removed") applyOp(parent.id, { kind: "remove", id: c.id });
    else if (c.kind === "changed") applyOp(parent.id, { kind: "set", id: c.id, field: c.field as never, value: c.to });
    else if (c.kind === "linked") addLink(parent.id, c.link);
  }
  set({ mergeResult: { conflicts: r.conflicts, applied: r.applied } });
  refresh();
  say(`Merged ${b.name} into ${parent.name}: ${r.applied} changes, ${r.conflicts.length} conflicts.`);
}

// ---------- collaboration ----------
export function addComment(position: V3, assetId: string | null, text: string) {
  const c: Comment = { id: `c-${state.me.actor}-${Date.now().toString(36)}`, author: state.me.name, assetId, position, text: text.slice(0, 280), at: new Date().toISOString() };
  set((s) => ({ comments: [...s.comments, c], commentMode: false }));
  collab?.send({ kind: "comment", comment: c });
  say(`Comment pinned${assetId ? ` on ${activeScene()?.assets.find((a) => a.id === assetId)?.name}` : ""}.`);
}
let lastPresence = 0, lastPoint: V3 | null = null;
export function sendPresence(point: V3 | null, force = false) {
  const now = performance.now();
  if (point) lastPoint = point;
  if (!force && now - lastPresence < 80) return;
  lastPresence = now;
  point = point ?? lastPoint;
  collab?.send({ kind: "presence", presence: { actor: state.me.actor, name: state.me.name, color: state.me.color, point, selected: state.selected, at: Date.now() } });
}
export function invite() {
  const u = new URL(location.href);
  u.search = "";
  u.searchParams.set("as", "collaborator-2"); u.searchParams.set("enter", "1");
  if (state.project) u.searchParams.set("project", state.project.id);
  return window.open(u.toString(), "_blank");
}

export function raiseAlert(text: string) {
  if (state.alerts.some((a) => a.text === text)) return;
  set((s) => ({ alerts: [{ id: `a${Date.now()}`, text, at: Date.now() }, ...s.alerts] }));
  say(text);
}
