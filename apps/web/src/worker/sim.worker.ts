/// <reference lib="webworker" />
// Runs the discrete-event simulation off the main thread: 30 replications per branch, one recorded run for playback.
import { compare, replicate, simulate, sizeBuffer } from "@forge/domain";
import type { FromWorker, ToWorker } from "./protocol.ts";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data, t0 = performance.now();
  try {
    if (m.type === "simulate") {
      const { raw: _raw, ...kpis } = replicate(m.scene, m.reps);
      const playback = simulate(m.scene, { hours: 1, warmupH: 1, seed: 1000, recordS: 3600 });
      post({ type: "simulate", id: m.id, kpis, playback, ms: performance.now() - t0 });
    } else if (m.type === "compare") {
      const c = compare(m.base, m.branch, m.reps);
      post({ type: "compare", id: m.id, ...c, ms: performance.now() - t0 });
    } else {
      const r = sizeBuffer(m.scene, m.bufferId, 8, 10);
      post({ type: "optimize", id: m.id, ...r, ms: performance.now() - t0 });
    }
  } catch (e) {
    post({ type: "error", id: m.id, message: e instanceof Error ? e.message : String(e) });
  }
};
