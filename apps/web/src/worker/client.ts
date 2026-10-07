// Promise wrapper around the simulation worker.
import type { FromWorker, ToWorker } from "./protocol.ts";

type Req = ToWorker extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

export class SimClient {
  private w: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { ok: (m: FromWorker) => void; err: (e: Error) => void }>();
  private worker() {
    if (!this.w) {
      this.w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const h = this.waiting.get(ev.data.id);
        if (!h) return;
        this.waiting.delete(ev.data.id);
        if (ev.data.type === "error") h.err(new Error(ev.data.message)); else h.ok(ev.data);
      };
    }
    return this.w;
  }
  call<T extends FromWorker["type"]>(req: Req): Promise<Extract<FromWorker, { type: T }>> {
    const id = ++this.seq;
    return new Promise((ok, err) => { this.waiting.set(id, { ok: ok as (m: FromWorker) => void, err }); this.worker().postMessage({ ...req, id }); });
  }
}
