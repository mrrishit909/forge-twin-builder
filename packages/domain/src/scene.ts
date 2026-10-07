// The twin's scene: assets from a small library, their transforms, the links between their connectors, telemetry bindings and
// world-space comments. Snapping (grid, angle, connector-aware) and (de)serialization live here so the editor, the API and the
// tests all agree on them. Units: metres, degrees.

export type AssetType = "source" | "conveyor" | "machine" | "robot" | "buffer" | "sink";
export type V3 = [number, number, number];

export interface Transform { position: V3; rotation: V3; scale: V3 }
export interface Asset { id: string; type: AssetType; name: string; transform: Transform; props: Record<string, number> }
export interface Link { from: string; to: string }
export interface Binding { id: string; assetId: string; connectorId: string; sourcePath: string; targetProperty: string; transform: string; unit: string }
export interface Comment { id: string; author: string; assetId: string | null; position: V3; text: string; at: string }
export interface Scene { version: 1; id: string; name: string; assets: Asset[]; links: Link[]; bindings: Binding[]; comments: Comment[] }

interface Port { local: V3; dir: V3 } // connector position and outward direction in the asset's local frame
export interface AssetSpec { label: string; size: V3; inPort?: Port; outPort?: Port; props: Record<string, number>; costUsd: number }

/** The asset library. Process figures are the defaults a new asset gets; the editor can change them per asset. */
export const LIBRARY: Record<AssetType, AssetSpec> = {
  source: { label: "Raw material", size: [1.2, 1, 1.2], outPort: { local: [0.6, 0.5, 0], dir: [1, 0, 0] }, props: { interarrivalS: 50 }, costUsd: 0 },
  conveyor: { label: "Conveyor", size: [4, 0.8, 0.8], inPort: { local: [-2, 0.8, 0], dir: [-1, 0, 0] }, outPort: { local: [2, 0.8, 0], dir: [1, 0, 0] }, props: { lengthM: 4, speedMps: 0.2, capacity: 5 }, costUsd: 18000 },
  machine: { label: "CNC machine", size: [2, 2, 1.6], inPort: { local: [-1, 0.8, 0], dir: [-1, 0, 0] }, outPort: { local: [1, 0.8, 0], dir: [1, 0, 0] }, props: { processS: 55, cv: 0.25, mtbfH: 2, mttrMin: 6, ratedRpm: 3200, maxTempC: 85 }, costUsd: 240000 },
  robot: { label: "Robot cell", size: [1.6, 1.8, 1.6], inPort: { local: [-0.8, 0.8, 0], dir: [-1, 0, 0] }, outPort: { local: [0.8, 0.8, 0], dir: [1, 0, 0] }, props: { cycleS: 20, cv: 0.1 }, costUsd: 95000 },
  buffer: { label: "Buffer rack", size: [1.4, 1.6, 1], inPort: { local: [-0.7, 0.8, 0], dir: [-1, 0, 0] }, outPort: { local: [0.7, 0.8, 0], dir: [1, 0, 0] }, props: { capacity: 4 }, costUsd: 6000 },
  sink: { label: "Finished goods", size: [1.2, 1, 1.2], inPort: { local: [-0.6, 0.5, 0], dir: [-1, 0, 0] }, props: {}, costUsd: 0 },
};

export const SNAP = { gridM: 0.5, angleDeg: 15, scaleStep: 0.1, connectorM: 1.2 };

const r = (x: number, step: number) => Math.round(x / step) * step;
const fix = (x: number) => +x.toFixed(6);
/** Grid, angle and scale snapping (the gizmo's snap settings). */
export function snapTransform(t: Transform): Transform {
  return {
    position: [fix(r(t.position[0], SNAP.gridM)), fix(Math.max(0, r(t.position[1], SNAP.gridM))), fix(r(t.position[2], SNAP.gridM))],
    rotation: t.rotation.map((a) => fix(((r(a, SNAP.angleDeg) % 360) + 360) % 360)) as V3,
    scale: t.scale.map((s) => fix(Math.min(4, Math.max(0.5, r(s, SNAP.scaleStep))))) as V3,
  };
}

/** Port position/direction in world space (rotation about Y only matters for floor layouts; X/Z tilt is applied too). */
export function portWorld(a: Asset, which: "in" | "out"): { pos: V3; dir: V3 } | null {
  const p = which === "in" ? LIBRARY[a.type].inPort : LIBRARY[a.type].outPort;
  if (!p) return null;
  const [rx, ry, rz] = a.transform.rotation.map((d) => (d * Math.PI) / 180);
  const s = a.transform.scale;
  const rot = (v: V3): V3 => {
    let [x, y, z] = v;
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    return [x, y, z];
  };
  const l = rot([p.local[0] * s[0], p.local[1] * s[1], p.local[2] * s[2]]);
  return { pos: [a.transform.position[0] + l[0], a.transform.position[1] + l[1], a.transform.position[2] + l[2]], dir: rot(p.dir) };
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Connector-aware snapping for an asset that was just moved: if its in-port is within SNAP.connectorM of another asset's free
 * out-port (or its out-port near a free in-port), turn it to face along that port and move it so the two ports coincide.
 * Returns the new transform and the link to add, or null when nothing is close enough.
 */
export function snapToConnector(scene: Scene, moved: Asset): { transform: Transform; link: Link } | null {
  let best: { d: number; transform: Transform; link: Link } | null = null;
  const usedOut = new Set(scene.links.map((l) => l.from)), usedIn = new Set(scene.links.map((l) => l.to));
  for (const other of scene.assets) {
    if (other.id === moved.id) continue;
    for (const [mine, theirs] of [["in", "out"], ["out", "in"]] as const) {
      const mp = LIBRARY[moved.type][mine === "in" ? "inPort" : "outPort"];
      const tp = portWorld(other, theirs);
      if (!mp || !tp) continue;
      if (theirs === "out" ? usedOut.has(other.id) : usedIn.has(other.id)) continue;
      const cur = portWorld(moved, mine)!;
      const gap = dist(cur.pos, tp.pos);
      if (gap > SNAP.connectorM || (best && gap >= best.d)) continue;
      // face the moved asset so its port points opposite to the other's: yaw from the other port's direction
      // in-port faces local -x, out-port local +x; yaw θ maps local +x to (cos θ, 0, -sin θ)
      const d = tp.dir;
      const yaw = ((mine === "in" ? Math.atan2(-d[2], d[0]) : Math.atan2(d[2], -d[0])) * 180) / Math.PI;
      const rotation: V3 = [0, ((Math.round(yaw / SNAP.angleDeg) * SNAP.angleDeg) % 360 + 360) % 360, 0];
      const trial: Asset = { ...moved, transform: { ...moved.transform, rotation } };
      const np = portWorld(trial, mine)!;
      const position: V3 = [0, 1, 2].map((k) => fix(trial.transform.position[k] + tp.pos[k] - np.pos[k])) as V3;
      best = { d: gap, transform: { ...trial.transform, position }, link: mine === "in" ? { from: other.id, to: moved.id } : { from: moved.id, to: other.id } };
    }
  }
  return best && { transform: best.transform, link: best.link };
}

// ---------- serialization ----------
/** JSON with keys sorted at every level: stable bytes for hashing, diffing and storage (jsonb does not keep key order). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const serialize = (s: Scene) => canonical(s);

export class SceneError extends Error {}
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Parse and validate a scene: unknown asset types, non-finite numbers, dangling links/bindings and duplicate ids are refused. */
export function parseScene(text: string | unknown): Scene {
  const s = (typeof text === "string" ? JSON.parse(text) : text) as Scene;
  const fail = (m: string): never => { throw new SceneError(m); };
  if (!s || s.version !== 1) fail("unsupported scene version");
  if (typeof s.id !== "string" || typeof s.name !== "string" || !Array.isArray(s.assets) || !Array.isArray(s.links)) fail("scene shape");
  const ids = new Set<string>();
  for (const a of s.assets) {
    if (typeof a.id !== "string" || !a.id || ids.has(a.id)) fail(`bad or duplicate asset id ${a?.id}`);
    ids.add(a.id);
    if (!(a.type in LIBRARY)) fail(`unknown asset type ${a.type}`);
    if (!a.transform || !isV3(a.transform.position) || !isV3(a.transform.rotation) || !isV3(a.transform.scale)) fail(`bad transform on ${a.id}`);
    if (a.transform.scale.some((x) => x <= 0)) fail(`non-positive scale on ${a.id}`);
    for (const [k, v] of Object.entries(a.props ?? {})) if (typeof v !== "number" || !Number.isFinite(v)) fail(`bad prop ${k} on ${a.id}`);
  }
  for (const l of s.links) if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to) fail(`dangling link ${l.from}->${l.to}`);
  for (const b of s.bindings ?? []) if (!ids.has(b.assetId)) fail(`binding to missing asset ${b.assetId}`);
  return { version: 1, id: s.id, name: s.name, assets: s.assets, links: s.links, bindings: s.bindings ?? [], comments: s.comments ?? [] };
}

export function newAsset(type: AssetType, id: string, position: V3, name?: string): Asset {
  return { id, type, name: name ?? LIBRARY[type].label, transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] }, props: { ...LIBRARY[type].props } };
}

/** The demo factory: one line, raw material -> conveyor -> CNC -> buffer -> robot -> press -> conveyor -> finished goods. */
export function templateFactory(id = "factory-demo"): Scene {
  const A = (t: AssetType, aid: string, x: number, name: string, props: Record<string, number> = {}) => ({ ...newAsset(t, aid, [x, 0, 0], name), props: { ...LIBRARY[t].props, ...props } });
  const assets: Asset[] = [
    A("source", "src", -12.6, "Raw material", { interarrivalS: 50 }),
    A("conveyor", "c1", -10, "Infeed conveyor"),
    A("machine", "m1", -7, "CNC mill M1", { processS: 55, cv: 0.25, mtbfH: 2, mttrMin: 6, ratedRpm: 3200, maxTempC: 85 }),
    A("buffer", "b1", -5.3, "Buffer B1", { capacity: 4 }),
    A("robot", "r1", -3.8, "Robot R1", { cycleS: 20, cv: 0.1 }),
    A("machine", "m2", -2, "Press M2", { processS: 38, cv: 0.15, mtbfH: 4, mttrMin: 8, ratedRpm: 1450, maxTempC: 80 }),
    A("conveyor", "c2", 1, "Outfeed conveyor"),
    A("sink", "snk", 3.6, "Finished goods"),
  ];
  const order = ["src", "c1", "m1", "b1", "r1", "m2", "c2", "snk"];
  // lay the line out port to port, so the template itself passes the connector check
  const scene: Scene = { version: 1, id, name: "Demo factory (synthetic)", assets, links: [], bindings: [], comments: [] };
  for (let k = 1; k < order.length; k++) {
    const prev = assets.find((a) => a.id === order[k - 1])!, cur = assets.find((a) => a.id === order[k])!;
    const out = portWorld(prev, "out")!, inn = portWorld(cur, "in")!;
    cur.transform.position = [fix(cur.transform.position[0] + out.pos[0] - inn.pos[0]), 0, 0];
    scene.links.push({ from: prev.id, to: cur.id });
  }
  return scene;
}
