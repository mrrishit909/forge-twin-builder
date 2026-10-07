// Discrete-event simulation of a line built from the scene graph. Each station holds parts in a queue (buffer/conveyor
// capacity) and works them with one server (conveyors: one server per slot, a fixed travel time). A finished part waits in its
// server until a downstream station has room (blocking after service). Machines fail on a wall-clock up/down schedule
// (exponential MTBF / MTTR) and a part in work waits out the repair. Seeded; same seed, same event trace.
import { rng } from "./rng.ts";
import type { Scene } from "./scene.ts";

export interface Station {
  id: string; name: string; kind: "source" | "conveyor" | "machine" | "robot" | "buffer" | "sink";
  queueCap: number; servers: number;
  service: (r: ReturnType<typeof rng>) => number; // seconds
  mtbfS?: number; mttrS?: number;
  next: string[];
}

export interface SimOptions { hours: number; warmupH: number; seed: number; /** record every part move for this many seconds after the warm-up (for playback) */ recordS?: number }
export interface StationStats { id: string; name: string; kind: string; busy: number; down: number; blocked: number; starved: number; processed: number }
export interface SimResult { throughputPerH: number; wipAvg: number; cycleMeanS: number; cycleP95S: number; released: number; completed: number; sunk: number; wipEnd: number; stations: StationStats[]; bottleneck: string; releaseRatePerH: number; supplyLimited: boolean; sourceBlocked: number; traceHash: string; ignored: string[]; moves?: [number, number, string][] }

const lognormal = (mean: number, cv: number) => (r: ReturnType<typeof rng>) => {
  if (cv <= 0) return mean;
  const s2 = Math.log(1 + cv * cv);
  return Math.exp(r.normal(Math.log(mean) - s2 / 2, Math.sqrt(s2)));
};

/** Turn a scene into stations. Throws if the line has no source, no sink, or a station with no way forward. */
export function stationsFromScene(scene: Scene): Station[] {
  const next = new Map<string, string[]>();
  for (const l of scene.links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const st = scene.assets.map<Station>((a) => {
    const p = a.props, n = next.get(a.id) ?? [];
    switch (a.type) {
      case "source": return { id: a.id, name: a.name, kind: "source", queueCap: 0, servers: 1, service: (r) => -Math.log(1 - r.u()) * (p.interarrivalS ?? 60), next: n };
      case "conveyor": { const cap = Math.max(1, Math.round(p.capacity ?? 5)); return { id: a.id, name: a.name, kind: "conveyor", queueCap: 0, servers: cap, service: () => (p.lengthM ?? 4) / (p.speedMps ?? 0.2), next: n }; }
      case "machine": return { id: a.id, name: a.name, kind: "machine", queueCap: 0, servers: 1, service: lognormal(p.processS ?? 60, p.cv ?? 0.2), mtbfS: (p.mtbfH ?? 0) * 3600 || undefined, mttrS: (p.mttrMin ?? 0) * 60 || undefined, next: n };
      case "robot": return { id: a.id, name: a.name, kind: "robot", queueCap: 0, servers: 1, service: lognormal(p.cycleS ?? 20, p.cv ?? 0.1), next: n };
      case "buffer": return { id: a.id, name: a.name, kind: "buffer", queueCap: Math.max(0, Math.round(p.capacity ?? 4)), servers: 1, service: () => 0, next: n };
      case "sink": return { id: a.id, name: a.name, kind: "sink", queueCap: Infinity, servers: Infinity, service: () => 0, next: [] };
    }
  });
  if (!st.some((s) => s.kind === "source")) throw new Error("the line has no raw-material source");
  if (!st.some((s) => s.kind === "sink")) throw new Error("the line has no finished-goods sink");
  // only what material can reach is simulated; equipment placed but not wired in yet is left out (and reported)
  const reach = new Set<string>(), todo = st.filter((s) => s.kind === "source").map((s) => s.id);
  while (todo.length) { const id = todo.pop()!; if (reach.has(id)) continue; reach.add(id); todo.push(...(next.get(id) ?? [])); }
  const live = st.filter((s) => reach.has(s.id));
  for (const s of live) if (s.kind !== "sink" && s.next.length === 0) throw new Error(`${s.name} is not connected to anything downstream`);
  for (const s of live) s.next = s.next.filter((x) => reach.has(x));
  if (!live.some((s) => s.kind === "sink")) throw new Error("no finished-goods sink is reachable from the raw material");
  return live;
}

interface Part { id: number; released: number }
interface Server { part: Part | null; doneAt: number; finished: boolean; since: number }

class Heap<T> {
  private a: [number, number, T][] = []; private seq = 0;
  push(t: number, v: T) { const a = this.a; a.push([t, this.seq++, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] < a[i][0] || (a[p][0] === a[i][0] && a[p][1] < a[i][1])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop(): [number, T] | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; const lt = (x: number, y: number) => a[x][0] < a[y][0] || (a[x][0] === a[y][0] && a[x][1] < a[y][1]); if (l < a.length && lt(l, m)) m = l; if (r < a.length && lt(r, m)) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return [top[0], top[2]];
  }
}

/** Downtime intervals for a machine over [0, end): alternating exponential up and down periods. */
function failureSchedule(s: Station, r: ReturnType<typeof rng>, end: number): [number, number][] {
  if (!s.mtbfS || !s.mttrS) return [];
  const out: [number, number][] = [];
  for (let t = -Math.log(1 - r.u()) * s.mtbfS; t < end; ) { const d = -Math.log(1 - r.u()) * s.mttrS; out.push([t, t + d]); t += d - Math.log(1 - r.u()) * s.mtbfS; }
  return out;
}
/** Completion time of `work` seconds started at t0 on a machine that stops during each downtime interval. */
function finishWith(t0: number, work: number, downs: [number, number][]) {
  let t = t0, left = work;
  for (const [a, b] of downs) {
    if (b <= t) continue;
    if (a >= t + left) break;
    if (a > t) { left -= a - t; t = a; }
    t = Math.max(t, b);
  }
  return t + left;
}

export function simulate(scene: Scene, o: SimOptions): SimResult {
  const st = stationsFromScene(scene);
  const ignored = scene.assets.filter((a) => !st.some((s) => s.id === a.id)).map((a) => a.id);
  const r = rng(o.seed);
  const end = (o.hours + o.warmupH) * 3600, warm = o.warmupH * 3600;
  const byId = new Map(st.map((s) => [s.id, s]));
  const queues = new Map<string, Part[]>(st.map((s) => [s.id, []]));
  const servers = new Map<string, Server[]>(st.map((s) => [s.id, Array.from({ length: Number.isFinite(s.servers) ? s.servers : 0 }, () => ({ part: null, doneAt: 0, finished: false, since: 0 }))]));
  const downs = new Map(st.map((s) => [s.id, failureSchedule(s, r, end)]));
  const stats = new Map<string, StationStats>(st.map((s) => [s.id, { id: s.id, name: s.name, kind: s.kind, busy: 0, down: 0, blocked: 0, starved: 0, processed: 0 }]));
  const rr = new Map(st.map((s) => [s.id, 0]));
  const heap = new Heap<{ kind: "release" | "done"; station: string; server: number }>();
  let nextId = 0, released = 0, completed = 0, sunk = 0, wipArea = 0, wip = 0, lastT = 0;
  const cycles: number[] = [];
  const moves: [number, number, string][] = [];
  const rec = (t: number, p: Part, sid: string) => { if (o.recordS && t >= warm && t <= warm + o.recordS) moves.push([+(t - warm).toFixed(2), p.id, sid]); };
  let trace = 2166136261;
  const mix = (x: number) => { trace = Math.imul(trace ^ (x >>> 0), 16777619) >>> 0; };
  // per-server time accounting: state since last change
  const acct = new Map<string, { state: "idle" | "busy" | "blocked"; at: number }[]>(st.map((s) => [s.id, (servers.get(s.id) ?? []).map(() => ({ state: "idle" as const, at: 0 }))]));
  const account = (sid: string, k: number, state: "idle" | "busy" | "blocked", t: number) => {
    const a = acct.get(sid)![k], s = stats.get(sid)!;
    const from = Math.max(a.at, warm), to = Math.max(t, warm);
    if (to > from) { if (a.state === "busy") s.busy += to - from; else if (a.state === "blocked") s.blocked += to - from; else s.starved += to - from; }
    a.state = state; a.at = t;
  };

  const canAccept = (sid: string) => {
    const s = byId.get(sid)!;
    if (s.kind === "sink") return true;
    return queues.get(sid)!.length < s.queueCap || servers.get(sid)!.some((v) => !v.part);
  };
  const accept = (sid: string, p: Part, t: number) => {
    const s = byId.get(sid)!;
    rec(t, p, sid);
    if (s.kind === "sink") { sunk++; completed += t >= warm ? 1 : 0; if (t >= warm) cycles.push(t - p.released); wip--; mix(p.id); mix(Math.round(t)); return; }
    const k = servers.get(sid)!.findIndex((v) => !v.part);
    if (k >= 0) start(sid, k, p, t); else queues.get(sid)!.push(p);
  };
  const start = (sid: string, k: number, p: Part, t: number) => {
    const s = byId.get(sid)!, v = servers.get(sid)![k];
    const work = s.service(r);
    v.part = p; v.finished = false; v.since = t;
    v.doneAt = s.kind === "machine" ? finishWith(t, work, downs.get(sid)!) : t + work;
    account(sid, k, "busy", t);
    heap.push(v.doneAt, { kind: "done", station: sid, server: k });
  };
  /** Push finished parts downstream wherever there is room, then refill servers from queues; repeat until nothing moves. */
  const settle = (t: number) => {
    for (let moved = true; moved; ) {
      moved = false;
      for (const s of st) {
        if (s.kind === "source" || s.kind === "sink") continue;
        // oldest finished part first: a conveyor is FIFO, and a newer part must not overtake one that is waiting
        const ready = servers.get(s.id)!.map((v, k) => [v, k] as const).filter(([v]) => v.part && v.finished).sort((a, b) => a[0].doneAt - b[0].doneAt);
        for (const [v, k] of ready) {
          const n = s.next.length, i0 = rr.get(s.id)!;
          for (let j = 0; j < n; j++) {
            const to = s.next[(i0 + j) % n];
            if (canAccept(to)) {
              const p = v.part!; v.part = null; v.finished = false; rr.set(s.id, (i0 + j + 1) % n);
              stats.get(s.id)!.processed += t >= warm ? 1 : 0;
              account(s.id, k, "idle", t);
              accept(to, p, t);
              const q = queues.get(s.id)!;
              if (q.length) start(s.id, k, q.shift()!, t);
              moved = true; mix(k); break;
            }
          }
          if (v.part) break; // still blocked: younger finished parts in this station wait behind it
        }
      }
    }
  };
  const src = st.filter((s) => s.kind === "source");
  for (const s of src) heap.push(s.service(r), { kind: "release", station: s.id, server: 0 });
  const blockedSrc: string[] = [];
  let srcBlockedSince = -1, srcBlockedS = 0; // time raw material waited because the first station was full
  for (let e = heap.pop(); e && e[0] <= end; e = heap.pop()) {
    const [t, ev] = e;
    wipArea += t > warm ? wip * (t - Math.max(lastT, warm)) : 0; lastT = t;
    if (ev.kind === "release") {
      const s = byId.get(ev.station)!, to = s.next.find(canAccept);
      if (to) { const p = { id: nextId++, released: t }; released++; wip++; accept(to, p, t); }
      else { blockedSrc.push(s.id); if (srcBlockedSince < 0) srcBlockedSince = t; } // raw material waits; it is released when the first station frees up
      heap.push(t + s.service(r), { kind: "release", station: s.id, server: 0 });
    } else {
      const v = servers.get(ev.station)![ev.server];
      v.finished = true;
      account(ev.station, ev.server, "blocked", t);
    }
    settle(t);
    while (blockedSrc.length) { const sid = blockedSrc[0], to = byId.get(sid)!.next.find(canAccept); if (!to) break; blockedSrc.shift();
      if (!blockedSrc.length && srcBlockedSince >= 0) { srcBlockedS += Math.max(0, t - Math.max(srcBlockedSince, warm)); srcBlockedSince = -1; } const p = { id: nextId++, released: t }; released++; wip++; accept(to, p, t); settle(t); }
  }
  for (const s of st) (servers.get(s.id) ?? []).forEach((v, k) => account(s.id, k, acct.get(s.id)![k].state, end));
  wipArea += wip * (end - Math.max(lastT, warm));
  const H = o.hours * 3600;
  const out: StationStats[] = [];
  for (const s of st) {
    if (s.kind === "source" || s.kind === "sink") continue;
    const x = stats.get(s.id)!, n = servers.get(s.id)!.length;
    // a machine's down time overlapping its working periods shows up as busy above; report it separately
    const down = (downs.get(s.id) ?? []).reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, end) - Math.max(a, warm)), 0);
    out.push({ ...x, busy: x.busy / (H * n), down: down / H, blocked: x.blocked / (H * n), starved: x.starved / (H * n) });
  }
  // bottleneck: the working station that is busy (or down) the largest share of the time
  const work = out.filter((s) => s.kind === "machine" || s.kind === "robot");
  const bottleneck = work.reduce((a, b) => (b.busy > a.busy ? b : a)).id;
  const sorted = [...cycles].sort((a, b) => a - b);
  if (srcBlockedSince >= 0) srcBlockedS += end - Math.max(srcBlockedSince, warm);
  // if raw material waits for room less than a quarter of the time, supply (the release rate) is the constraint, not any station
  const releaseRatePerH = st.filter((s) => s.kind === "source").reduce((a, s) => a + 3600 / (scene.assets.find((x) => x.id === s.id)!.props.interarrivalS ?? 60), 0);
  return {
    throughputPerH: completed / o.hours, wipAvg: wipArea / H, cycleMeanS: cycles.reduce((a, b) => a + b, 0) / Math.max(1, cycles.length),
    cycleP95S: sorted[Math.floor(sorted.length * 0.95)] ?? 0, released, completed, sunk, wipEnd: wip, stations: out, bottleneck, releaseRatePerH, supplyLimited: srcBlockedS / H < 0.25, sourceBlocked: srcBlockedS / H, traceHash: trace.toString(16), ignored, ...(o.recordS ? { moves } : {}),
  };
}

// ---------- replications and comparison ----------
/** Student t 97.5% quantile (Cornish-Fisher expansion around the normal; within 0.5% for df >= 4). */
const tq = (df: number) => { const z = 1.959964; return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df); };
export interface Estimate { mean: number; lo: number; hi: number; n: number }
export const estimate = (xs: number[]): Estimate => {
  const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  const h = n > 1 ? (tq(n - 1) * sd) / Math.sqrt(n) : 0;
  return { mean: m, lo: m - h, hi: m + h, n };
};

export const ASSUMPTIONS = [
  "8-hour shift after a 1-hour warm-up, 30 replications, common random numbers between branches",
  "raw material always available, released every interarrivalS seconds on average (exponential)",
  "machine and robot times lognormal with the asset's mean and coefficient of variation",
  "machines fail on an exponential MTBF / MTTR clock; a part in work waits out the repair",
  "blocking after service; parts split round-robin between parallel stations; no operators, changeovers or scrap",
];

export interface Kpis { ignored: string[]; supplyLimitedShare: number; releaseRatePerH: number; sourceBlocked: Estimate; throughputPerH: Estimate; cycleMeanS: Estimate; wipAvg: Estimate; utilization: Record<string, Estimate>; bottleneck: { id: string; share: number }[]; assumptions: string[]; runs: number }

export function replicate(scene: Scene, reps = 30, seed0 = 1000, hours = 8, warmupH = 1): Kpis & { raw: SimResult[] } {
  const raw = Array.from({ length: reps }, (_, k) => simulate(scene, { hours, warmupH, seed: seed0 + k }));
  const ids = raw[0].stations.map((s) => s.id);
  const bn = new Map<string, number>();
  for (const x of raw) bn.set(x.bottleneck, (bn.get(x.bottleneck) ?? 0) + 1);
  return {
    ignored: raw[0].ignored, supplyLimitedShare: raw.filter((x) => x.supplyLimited).length / reps, releaseRatePerH: raw[0].releaseRatePerH, sourceBlocked: estimate(raw.map((x) => x.sourceBlocked)),
    throughputPerH: estimate(raw.map((x) => x.throughputPerH)), cycleMeanS: estimate(raw.map((x) => x.cycleMeanS)), wipAvg: estimate(raw.map((x) => x.wipAvg)),
    utilization: Object.fromEntries(ids.map((id) => [id, estimate(raw.map((x) => x.stations.find((s) => s.id === id)!.busy))])),
    bottleneck: [...bn].map(([id, c]) => ({ id, share: c / reps })).sort((a, b) => b.share - a.share), assumptions: ASSUMPTIONS, runs: reps, raw,
  };
}

/** Branch vs base with common random numbers: the confidence interval is on the paired differences. */
export function compare(base: Scene, branch: Scene, reps = 30) {
  const a = replicate(base, reps), b = replicate(branch, reps);
  const diff = estimate(a.raw.map((x, k) => b.raw[k].throughputPerH - x.throughputPerH));
  return { base: strip(a), branch: strip(b), throughputDiff: diff, significant: diff.lo > 0 || diff.hi < 0 };
}
const strip = ({ raw: _, ...k }: Kpis & { raw: SimResult[] }) => k;

/** Smallest capacity for one buffer that gets within `tolerance` of the best throughput found over 0..maxCap. */
export function sizeBuffer(scene: Scene, bufferId: string, maxCap = 10, reps = 10, tolerance = 0.01) {
  const rows = Array.from({ length: maxCap + 1 }, (_, cap) => {
    const s: Scene = { ...scene, assets: scene.assets.map((a) => (a.id === bufferId ? { ...a, props: { ...a.props, capacity: cap } } : a)) };
    return { capacity: cap, throughputPerH: replicate(s, reps).throughputPerH.mean };
  });
  const best = Math.max(...rows.map((r) => r.throughputPerH));
  return { rows, chosen: rows.find((r) => r.throughputPerH >= best * (1 - tolerance))!.capacity, best };
}
