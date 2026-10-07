// Telemetry simulator for the Docker stack: the same seeded plant as the browser sandbox, published to Mosquitto with retained
// messages at 20 simulated seconds per real second. Listens on forge/demo/control/fault to start a bearing fault on a machine.
import mqtt from "mqtt";
import { PlantSim, DEMO_MACHINES } from "../../packages/domain/src/index.ts";

const warp = Number(process.env.WARP ?? 20);
const plant = new PlantSim("demo", DEMO_MACHINES.map((m) => ({ ...m, faultAtS: null })), 42);
const c = mqtt.connect(process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883", { username: process.env.MQTT_USER, password: process.env.MQTT_PASS, reconnectPeriod: 1000 });
const t0 = Date.now();
c.on("connect", () => { console.log(JSON.stringify({ msg: "plant simulator connected", warp })); c.subscribe("forge/demo/control/#"); });
c.on("message", (topic, payload) => {
  if (topic !== "forge/demo/control/fault") return;
  const id = JSON.parse(payload.toString()).machine, s = plant.sims.find((x) => x.m.id === id);
  if (s) { s.m.faultAtS = s.seconds; console.log(JSON.stringify({ msg: "bearing fault started", machine: id, atS: s.seconds })); }
});
setInterval(() => { if (c.connected) for (let k = 0; k < warp; k++) plant.tick(t0, (r) => c.publish(r.topic, JSON.stringify(r), { retain: true })); }, 1000);
