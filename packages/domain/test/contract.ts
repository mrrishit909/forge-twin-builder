// Connector contract: every connector (the in-browser simulator, MQTT against Mosquitto) must pass the same checks.
import { expect } from "vitest";
import type { Connector, Reading } from "../src/index.ts";

export interface ContractHarness {
  make(): Connector;
  publish(r: Reading): Promise<void> | void;
  cut(): Promise<void> | void;
  restore(): Promise<void> | void;
  wait(ms: number): Promise<void>;
}

export async function connectorContract(h: ContractHarness, prefix = `forge/contract-${Date.now().toString(36)}`) {
  const c = h.make();
  const states: string[] = [];
  c.onState((s) => states.push(s));
  await c.connect();
  expect(c.state).toBe("connected");
  const got: Reading[] = [];
  c.subscribe(`${prefix}/+/rpm`, (r) => got.push(r));
  await h.publish({ topic: `${prefix}/m1/rpm`, ts: 1, value: 3100, unit: "rpm" });
  await h.publish({ topic: `${prefix}/m1/temperature`, ts: 1, value: 40, unit: "°C" }); // not matched by the filter
  await h.wait(150);
  expect(got.map((r) => r.value)).toEqual([3100]);
  // the broker goes away: the connector notices, backs off, and comes back with the retained latest value
  await h.cut();
  await h.wait(300);
  expect(["backoff", "connecting"]).toContain(c.state);
  await h.publish({ topic: `${prefix}/m1/rpm`, ts: 2, value: 3150, unit: "rpm" });
  await h.restore();
  for (let i = 0; i < 100 && c.state !== "connected"; i++) await h.wait(100);
  expect(c.state).toBe("connected");
  for (let i = 0; i < 30 && got.at(-1)?.value !== 3150; i++) await h.wait(100);
  expect(got.at(-1)?.value).toBe(3150);
  expect(states).toContain("backoff");
  await c.close();
  expect(c.state).toBe("closed");
}
