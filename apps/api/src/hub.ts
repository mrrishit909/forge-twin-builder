// Telemetry hub: one MQTT subscription to the plant (Mosquitto), fanned out to WebSocket clients. Each client has a bounded
// queue that coalesces per topic and drops the oldest under backpressure; flushed every 100 ms, skipped while the socket's
// send buffer is full. Latest values are written to telemetry_points once a second for projects with a connector.
import { TelemetryQueue, type Reading } from "../../../packages/domain/src/index.ts";
import { withTenant } from "./db.ts";
import { MqttConnector } from "./mqtt-connector.ts";

interface Client { send: (s: string) => void; buffered: () => number; q: TelemetryQueue; project: string }

export class Hub {
  clients = new Set<Client>();
  conn: MqttConnector | null = null;
  up = false;
  stats = { received: 0, sent: 0, dropped: 0, coalesced: 0 };
  ingest = new Map<string, { tenant: string }>(); // project id -> tenant, for storage
  private latest = new Map<string, Reading>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private url: string; private user?: string; private pass?: string;
  constructor(url: string, user?: string, pass?: string) { this.url = url; this.user = user; this.pass = pass; }

  start() {
    this.connect();
    this.timers.push(setInterval(() => this.flush(), 100), setInterval(() => void this.store(), 1000));
  }
  private connect() {
    const c = new MqttConnector(this.url, this.user, this.pass);
    this.conn = c;
    c.onState((st, info) => {
      const was = this.up;
      this.up = st === "connected";
      if (this.up && !was) this.broadcast({ status: "ok" });
      if (!this.up && was) this.broadcast({ status: "broker-down", info: info ?? "broker unreachable; reconnecting" });
    });
    c.subscribe("forge/demo/#", (r) => {
      if (!r || typeof r.topic !== "string" || r.topic.startsWith("forge/demo/control/")) return;
      this.stats.received++;
      this.latest.set(r.topic, r);
      for (const cl of this.clients) cl.q.push(r);
    });
    void c.connect();
  }
  /** Lab: the platform loses the broker for `ms`, then reconnects (retained messages refill the latest values). */
  outage(ms: number) { void this.conn?.close(); this.up = false; this.broadcast({ status: "broker-down", info: `broker unreachable (simulated for ${ms} ms)` }); setTimeout(() => this.connect(), ms); }
  publish(topic: string, payload: unknown, retain = false) { this.conn?.publish(topic, payload, retain); }
  attach(project: string, send: (s: string) => void, buffered: () => number) {
    const cl: Client = { send, buffered, q: new TelemetryQueue(512), project };
    for (const r of this.latest.values()) cl.q.push(r);
    this.clients.add(cl);
    send(JSON.stringify({ status: this.up ? "ok" : "broker-down", info: this.up ? "connected" : "broker unreachable" }));
    return () => { this.stats.dropped += cl.q.dropped; this.stats.coalesced += cl.q.coalesced; this.clients.delete(cl); };
  }
  private broadcast(m: unknown) { const s = JSON.stringify(m); for (const c of this.clients) c.send(s); }
  private flush() {
    for (const c of this.clients) {
      if (c.buffered() > 1 << 20) continue; // slow client: let its queue coalesce instead of growing the socket buffer
      const batch = c.q.drain(500);
      if (batch.length) { c.send(JSON.stringify({ readings: batch })); this.stats.sent += batch.length; }
    }
  }
  private async store() {
    if (!this.ingest.size || !this.latest.size) return;
    const rows = [...this.latest.values()].filter((r) => /\/(rpm|temperature|vibration)$/.test(r.topic));
    for (const [project, { tenant }] of this.ingest) {
      const vals = rows.map((r) => { const [, , asset, metric] = r.topic.split("/"); return [project, asset, tenant, metric, new Date(r.ts).toISOString(), r.value]; });
      if (!vals.length) continue;
      await withTenant(tenant, (c) => c.query(`INSERT INTO telemetry_points (project_id, asset_id, tenant_id, metric, ts, value) SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::timestamptz[], $6::float8[]) ON CONFLICT DO NOTHING`,
        [0, 1, 2, 3, 4, 5].map((k) => vals.map((v) => v[k])))).catch(() => {});
    }
  }
  stop() { for (const t of this.timers) clearInterval(t); void this.conn?.close(); }
}
