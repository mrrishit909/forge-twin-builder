// Telemetry: a seeded plant simulator (RPM, temperature, vibration, flow, status per machine), the topic layout it publishes on,
// a bounded queue that coalesces and drops under backpressure, a reconnecting connector state machine, and an in-memory broker
// that behaves like MQTT (topic wildcards, retained messages, disconnects) for the browser sandbox and the contract tests.
import { rng } from "./rng.ts";

export type Metric = "rpm" | "temperature" | "vibration" | "flow" | "status";
export const METRICS: Metric[] = ["rpm", "temperature", "vibration", "flow", "status"];
export const UNITS: Record<Metric, string> = { rpm: "rpm", temperature: "°C", vibration: "mm/s", flow: "parts/min", status: "" };
export const STATUS = ["running", "idle", "fault"] as const;

export interface Reading { topic: string; ts: number; value: number; unit: string }
export const topicOf = (site: string, asset: string, m: Metric) => `forge/${site}/${asset}/${m}`;

export interface MachineModel { id: string; ratedRpm: number; maxTempC: number; /** bearing fault starts at this many seconds, or null */ faultAtS: number | null; failAfterS: number }

/**
 * One machine, stepped once a second. Load cycles with parts; temperature follows load with a first-order lag; vibration is a
 * healthy RMS plus noise until a bearing fault starts, then grows exponentially until the machine trips (status fault, rpm 0).
 */
export class MachineSim {
  m: MachineModel; private r: ReturnType<typeof rng>; private t = 0; private temp = 24; private tripped = false;
  constructor(m: MachineModel, seed: number) { this.m = m; this.r = rng(seed); }
  step(): Record<Metric, number> {
    this.t++;
    const m = this.m, cycle = (this.t % 60) / 60;
    const busy = cycle < 0.82 ? 1 : 0; // ~82% of each minute cutting, the rest loading
    const faultAge = m.faultAtS !== null && this.t > m.faultAtS ? this.t - m.faultAtS : 0;
    if (faultAge > m.failAfterS) this.tripped = true;
    const rpm = this.tripped ? 0 : busy * m.ratedRpm * (1 + this.r.normal(0, 0.01));
    const heat = this.tripped ? 0 : busy * 0.62 + (faultAge ? Math.min(0.25, faultAge / m.failAfterS * 0.25) : 0);
    this.temp += ((24 + heat * (m.maxTempC - 24)) - this.temp) / 90 + this.r.normal(0, 0.05);
    const vib = this.tripped ? 0.1 : (busy ? 1.8 : 0.6) * (1 + this.r.normal(0, 0.08)) + (faultAge ? 0.15 * Math.exp((faultAge / m.failAfterS) * 3.2) : 0);
    const status = this.tripped ? 2 : busy ? 0 : 1;
    return { rpm: Math.max(0, rpm), temperature: this.temp, vibration: Math.max(0, vib), flow: busy ? 60 / 55 : 0, status };
  }
  get seconds() { return this.t; }
}

// ---------- backpressure ----------
/** Bounded queue for one consumer. Newer readings of a topic replace older unsent ones; when still full the oldest is dropped. */
export class TelemetryQueue {
  private q = new Map<string, Reading>(); // insertion order = age
  dropped = 0; coalesced = 0; capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  push(r: Reading) {
    if (this.q.has(r.topic)) { this.q.delete(r.topic); this.coalesced++; }
    else if (this.q.size >= this.capacity) { const oldest = this.q.keys().next().value!; this.q.delete(oldest); this.dropped++; }
    this.q.set(r.topic, r);
  }
  drain(max = Infinity): Reading[] {
    const out: Reading[] = [];
    for (const [k, v] of this.q) { if (out.length >= max) break; out.push(v); this.q.delete(k); }
    return out;
  }
  get size() { return this.q.size; }
}

// ---------- connector state machine ----------
export type ConnState = "idle" | "connecting" | "connected" | "backoff" | "closed";
/** Exponential backoff with full jitter, capped; the random source is injected so tests are deterministic. */
export const backoffMs = (attempt: number, rand: () => number, baseMs = 500, capMs = 8000) => Math.round(rand() * Math.min(capMs, baseMs * 2 ** attempt));

export interface Connector {
  readonly kind: string;
  state: ConnState;
  connect(): Promise<void>;
  subscribe(filter: string, on: (r: Reading) => void): () => void;
  onState(cb: (s: ConnState, info?: string) => void): () => void;
  close(): Promise<void>;
}

/** MQTT topic filter match with + and # wildcards. */
export function topicMatches(filter: string, topic: string) {
  const f = filter.split("/"), t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/** In-memory broker: what the browser sandbox talks to in place of Mosquitto. Keeps retained messages; can be cut. */
export class SimBroker {
  private subs = new Set<{ filter: string; cb: (r: Reading) => void; client: SimConnector }>();
  private retained = new Map<string, Reading>();
  up = true;
  publish(r: Reading) {
    this.retained.set(r.topic, r);
    if (!this.up) return;
    for (const s of this.subs) if (s.client.state === "connected" && topicMatches(s.filter, r.topic)) s.cb(r);
  }
  attach(client: SimConnector, filter: string, cb: (r: Reading) => void) {
    const s = { filter, cb, client };
    this.subs.add(s);
    for (const r of this.retained.values()) if (topicMatches(filter, r.topic)) cb(r); // retained values replay on subscribe
    return () => this.subs.delete(s);
  }
  replayRetained(client: SimConnector) {
    for (const s of this.subs) if (s.client === client) for (const r of this.retained.values()) if (topicMatches(s.filter, r.topic)) s.cb(r);
  }
  /** Drop every connection (as when the broker restarts); clients see the drop and reconnect when it is back. */
  cut() { this.up = false; for (const s of this.subs) s.client.dropped(); }
  restore() { this.up = true; }
}

export class SimConnector implements Connector {
  readonly kind = "mqtt-sim";
  state: ConnState = "idle";
  attempts = 0;
  private listeners = new Set<(s: ConnState, info?: string) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private broker: SimBroker; private rand: () => number; private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  constructor(broker: SimBroker, rand: () => number = Math.random, schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms)) { this.broker = broker; this.rand = rand; this.schedule = schedule; }
  private set(s: ConnState, info?: string) { this.state = s; for (const l of this.listeners) l(s, info); }
  async connect() {
    this.set("connecting");
    if (!this.broker.up) return this.retry("broker unreachable");
    this.attempts = 0;
    this.set("connected");
    this.broker.replayRetained(this);
  }
  private retry(why: string) {
    const ms = backoffMs(this.attempts++, this.rand);
    this.set("backoff", `${why}; retry ${this.attempts} in ${ms} ms`);
    this.timer = this.schedule(() => { if (this.state === "backoff") this.connect(); }, ms);
  }
  dropped() { if (this.state === "connected") this.retry("connection lost"); }
  subscribe(filter: string, on: (r: Reading) => void) { return this.broker.attach(this, filter, on); }
  onState(cb: (s: ConnState, info?: string) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async close() { if (this.timer) clearTimeout(this.timer); this.set("closed"); }
}

/** Publishes every machine's five metrics once per simulated second. */
export class PlantSim {
  sims: MachineSim[]; site: string;
  constructor(site: string, models: MachineModel[], seed: number) { this.site = site; this.sims = models.map((m, k) => new MachineSim(m, seed + k * 7919)); }
  tick(t0: number, publish: (r: Reading) => void) {
    for (const s of this.sims) {
      const v = s.step();
      for (const m of METRICS) publish({ topic: topicOf(this.site, s.m.id, m), ts: t0 + s.seconds * 1000, value: +v[m].toFixed(3), unit: UNITS[m] });
    }
  }
}

/** The two demo machines. M2's bearing starts to fail 25 minutes in and trips 40 minutes after that (synthetic). */
export const DEMO_MACHINES: MachineModel[] = [
  { id: "m1", ratedRpm: 3200, maxTempC: 85, faultAtS: null, failAfterS: 1 },
  { id: "m2", ratedRpm: 1450, maxTempC: 80, faultAtS: 1500, failAfterS: 2400 },
];
