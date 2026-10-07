// Live telemetry as rendered: latest reading and a short history per topic, the values each binding drives on its asset, and
// the per-machine anomaly score. High-frequency, so it lives outside the React store; the UI samples it a few times a second.
import { compile, TelemetryQueue, VibrationMonitor, type Binding, type Reading } from "@forge/domain";

const HIST = 240;
export const live = {
  latest: new Map<string, Reading>(),
  history: new Map<string, number[]>(),
  /** asset id -> bound property -> value after the binding's transform */
  bound: new Map<string, Record<string, number>>(),
  received: 0,
  lastAt: 0,
  queue: new TelemetryQueue(512), // between the connector and the frame loop: coalesces per topic under bursts
};

const monitors = new Map<string, VibrationMonitor>();
let alarmCb: (asset: string, score: number) => void = () => {};
export const onAlarm = (cb: (asset: string, score: number) => void) => { alarmCb = cb; };
export const anomalyScore = (asset: string) => monitors.get(asset)?.score ?? null;
export const monitorReady = (asset: string) => monitors.get(asset)?.ready ?? false;

let compiled: { b: Binding; f: (v: number) => number }[] = [];
export function setBindings(bs: Binding[]) {
  compiled = bs.flatMap((b) => { try { return [{ b, f: compile(b.transform) }]; } catch { return []; } });
  live.bound.clear();
}

/** Called by the connector for every message; cheap, so a telemetry storm only costs a map write. */
export function ingest(r: Reading) {
  live.queue.push(r); live.received++;
  // the detector needs every sample, so it runs here, before the queue coalesces bursts
  const [, , asset, metric] = r.topic.split("/");
  if (metric === "status") statusNow.set(asset, r.value);
  else if (metric === "vibration") {
    const m = monitors.get(asset) ?? new VibrationMonitor();
    monitors.set(asset, m);
    const had = m.alarmAt !== null;
    m.push(r.ts / 1000, r.value, (statusNow.get(asset) ?? 0) === 0);
    if (!had && m.alarmAt !== null) alarmCb(asset, m.score);
  }
}
const statusNow = new Map<string, number>();

/** Called once per frame: drain the queue, update history and bound values. */
export function pump() {
  const batch = live.queue.drain(2000);
  for (const r of batch) {
    live.latest.set(r.topic, r);
    const h = live.history.get(r.topic) ?? [];
    h.push(r.value);
    if (h.length > HIST) h.shift();
    live.history.set(r.topic, h);
    live.lastAt = Date.now();
    for (const { b, f } of compiled) if (b.sourcePath === r.topic) {
      const cur = live.bound.get(b.assetId) ?? {};
      cur[b.targetProperty] = f(r.value);
      live.bound.set(b.assetId, cur);
    }
  }
  return batch.length;
}

export const valueOf = (topic: string) => live.latest.get(topic)?.value;
export const historyOf = (topic: string) => live.history.get(topic) ?? [];
export function resetLive() { monitors.clear(); live.latest.clear(); live.history.clear(); live.bound.clear(); live.received = 0; }
