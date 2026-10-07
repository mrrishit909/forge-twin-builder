// Scene performance: a factory campus of 2,000 assets drawn with instancing and a near/far level of detail.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ready, state } from "./helpers.ts";

test("2,000-asset campus with LOD and instancing", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /Stress: factory campus/ }).click();
  await page.getByRole("button", { name: "Telemetry HUD" }).click();
  await page.waitForTimeout(4000);
  const s = await state(page);
  const info = s.stressInfo as { near: number; far: number };
  expect(info.near + info.far).toBe(2000);
  expect(info.far).toBeGreaterThan(0);
  const t = await page.evaluate(() => (window as unknown as { __forge: { telemetry: () => Record<string, unknown> } }).__forge.telemetry());
  const r = t.render as { calls: number };
  expect(r.calls).toBeLessThan(40); // instanced: a handful of draw calls, not one per asset
  expect(t.fps as number).toBeGreaterThan(0);
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/performance-e2e.json", JSON.stringify({ note: "headless Chrome with SwiftShader (software GL): FPS is a floor, not a GPU figure", lod: info, ...t }, null, 1));
});
