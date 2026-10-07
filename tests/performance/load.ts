// Load test: concurrent HTTP clients on read paths and the simulation endpoint, then N WebSocket telemetry subscribers held
// open while the plant simulator publishes. node tests/performance/load.ts [base] [httpClients] [seconds] [wsClients]
import WebSocket from "ws";

const [base = "http://127.0.0.1:8523", clients = "32", secs = "10", wsN = "1000"] = process.argv.slice(2);
const H = { authorization: "Bearer acme-engineer-demo" };
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const proj = await (await fetch(`${base}/v1/projects`, { method: "POST", headers: { ...H, "content-type": "application/json", "idempotency-key": `load-${Date.now()}` }, body: JSON.stringify({ name: "load test" }) })).json();

async function http(paths: string[], method = "GET", body?: unknown, n = +clients) {
  const lat: number[] = []; let errors = 0;
  const end = Date.now() + +secs * 1000;
  await Promise.all(Array.from({ length: n }, async (_, c) => {
    for (let i = c; Date.now() < end; i++) {
      const t = performance.now();
      const r = await fetch(base + paths[i % paths.length], { method, headers: { ...H, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
      lat.push(performance.now() - t);
      if (!r || r.status >= 400) errors++;
      await r?.arrayBuffer();
    }
  }));
  return { requests: lat.length, rps: Math.round(lat.length / +secs), p50: +q(lat, 0.5).toFixed(1), p95: +q(lat, 0.95).toFixed(1), p99: +q(lat, 0.99).toFixed(1), errors };
}

async function ws() {
  let open = 0, failed = 0, readings = 0;
  const socks: WebSocket[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: +wsN }, () => new Promise<void>((ok) => {
    const s = new WebSocket(`${base.replace(/^http/, "ws")}/v1/projects/${proj.id}/telemetry?token=acme-viewer-demo`);
    socks.push(s);
    s.on("open", () => { open++; ok(); });
    s.on("message", (d) => { const m = JSON.parse(String(d)); readings += m.readings?.length ?? 0; });
    s.on("error", () => { failed++; ok(); });
  })));
  const openedMs = Date.now() - t0;
  readings = 0;
  await new Promise((r) => setTimeout(r, 10_000));
  socks.forEach((s) => s.close());
  return { requested: +wsN, open, failed, openedInMs: openedMs, readingsPerSecTotal: Math.round(readings / 10), readingsPerSecPerClient: +(readings / 10 / Math.max(1, open)).toFixed(1) };
}

const reads = await http([`/v1/projects/${proj.id}`, "/v1/templates/demo", `/v1/assets/m1/timeseries?projectId=${proj.id}&metric=rpm`, `/v1/connectors?projectId=${proj.id}`]);
const sims = await http([`/v1/branches/production/simulate?projectId=${proj.id}`], "POST", { reps: 30 }, 8);
const sockets = await ws();
console.log(JSON.stringify({ base, httpClients: +clients, seconds: +secs, reads, simulate30Shifts: sims, websocket: sockets }, null, 1));
