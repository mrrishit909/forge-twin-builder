// MQTT connector (mqtt.js) behind the same Connector interface as the browser's simulated broker, so both pass one contract
// test. Reconnects itself with jittered exponential backoff; retained messages refill the latest values on resubscribe.
import mqtt, { type MqttClient } from "mqtt";
import { backoffMs, topicMatches, type ConnState, type Connector, type Reading } from "../../../packages/domain/src/index.ts";

export class MqttConnector implements Connector {
  readonly kind = "mqtt";
  state: ConnState = "idle";
  client: MqttClient | null = null;
  private subs = new Set<{ filter: string; cb: (r: Reading) => void }>();
  private listeners = new Set<(s: ConnState, info?: string) => void>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private url: string; private user?: string; private pass?: string;
  constructor(url: string, user?: string, pass?: string) { this.url = url; this.user = user; this.pass = pass; }
  private set(s: ConnState, info?: string) { this.state = s; for (const l of this.listeners) l(s, info); }
  connect(): Promise<void> {
    this.set("connecting");
    return new Promise((resolve) => {
      const c = mqtt.connect(this.url, { username: this.user, password: this.pass, reconnectPeriod: 0, connectTimeout: 2000 });
      this.client = c;
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      c.on("connect", () => {
        this.attempts = 0;
        for (const s of this.subs) c.subscribe(s.filter);
        this.set("connected"); done();
      });
      c.on("message", (topic, payload) => {
        let r: Reading;
        try { r = JSON.parse(payload.toString()); } catch { return; }
        for (const s of this.subs) if (topicMatches(s.filter, topic)) s.cb(r);
      });
      const lost = (why: string) => {
        if (this.state === "closed" || this.state === "backoff") return;
        c.removeAllListeners(); c.end(true);
        const ms = backoffMs(this.attempts++, Math.random);
        this.set("backoff", `${why}; retry ${this.attempts} in ${ms} ms`);
        this.timer = setTimeout(() => { if (this.state === "backoff") void this.connect(); }, ms);
        done();
      };
      c.on("close", () => lost("connection lost"));
      c.on("error", (e) => lost(e.message));
    });
  }
  subscribe(filter: string, cb: (r: Reading) => void) {
    const s = { filter, cb };
    this.subs.add(s);
    if (this.state === "connected") this.client?.subscribe(filter);
    return () => { this.subs.delete(s); };
  }
  onState(cb: (s: ConnState, info?: string) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  publish(topic: string, payload: unknown, retain = false) { this.client?.publish(topic, JSON.stringify(payload), { retain }); }
  async close() { if (this.timer) clearTimeout(this.timer); this.set("closed"); this.client?.end(true); }
}
