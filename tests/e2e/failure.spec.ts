// Realistic failures, demonstrated and recovered: the MQTT broker drops, a telemetry storm hits, a bearing starts to fail,
// the GPU context is lost.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

async function connectM2(page: import("@playwright/test").Page) {
  await ready(page, "/?enter=1");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search assets/).fill("Press M2");
  await page.keyboard.press("Enter");
  const insp = page.getByRole("complementary", { name: /Inspector: Press M2/ });
  await insp.getByRole("button", { name: "Connect MQTT telemetry" }).click();
  await insp.locator(".bind-row", { hasText: "Vibration" }).getByRole("button").click();
  await expect.poll(async () => ((await state(page)).connector as { state: string }).state).toBe("connected");
  return insp;
}
const lab = async (page: import("@playwright/test").Page, item: RegExp) => { await page.getByRole("button", { name: /Failure lab/ }).click(); await page.getByRole("menuitem", { name: item }).click(); };

test("broker outage: backoff, stale values, reconnect, retained values refill", async ({ page }) => {
  await connectM2(page);
  await lab(page, /Drop the MQTT broker/);
  await expect(page.getByRole("alert").filter({ hasText: "Telemetry connection lost" })).toBeVisible({ timeout: 5_000 });
  await expect.poll(async () => ((await state(page)).connector as { state: string }).state).toBe("backoff");
  await expect.poll(async () => ((await state(page)).connector as { state: string }).state, { timeout: 20_000 }).toBe("connected");
  const before = await page.evaluate(() => (window as unknown as { __forge: { live: { received: number } } }).__forge.live.received);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __forge: { live: { received: number } } }).__forge.live.received), { timeout: 10_000 }).toBeGreaterThan(before);
});

test("telemetry storm: the queue coalesces and drops instead of freezing the page", async ({ page }) => {
  await connectM2(page);
  await lab(page, /Telemetry storm/);
  await page.waitForTimeout(1500);
  const q = await page.evaluate(() => { const l = (window as unknown as { __forge: { live: { queue: { size: number; dropped: number; coalesced: number; capacity: number }; received: number } } }).__forge.live; return { size: l.queue.size, dropped: l.queue.dropped, coalesced: l.queue.coalesced, cap: l.queue.capacity, received: l.received }; });
  expect(q.received).toBeGreaterThan(20000);
  expect(q.dropped).toBeGreaterThan(0);
  expect(q.size).toBeLessThanOrEqual(q.cap);
  const fps = await page.evaluate(() => (window as unknown as { __forge: { telemetry: () => { fps: number } } }).__forge.telemetry().fps);
  expect(fps).toBeGreaterThan(0);
});

test("bearing fault: vibration alarm before the machine trips", async ({ page }) => {
  test.setTimeout(240_000);
  await connectM2(page);
  // the detector first learns a healthy baseline (600 running seconds = about 37 s at the sandbox's 20x plant clock)
  await page.waitForTimeout(40_000);
  await lab(page, /bearing fault/);
  await expect(page.getByRole("alert").filter({ hasText: /Vibration on Press M2/ })).toBeVisible({ timeout: 120_000 });
  const status = await page.evaluate(() => (window as unknown as { __forge: { live: { latest: Map<string, { value: number }> } } }).__forge.live.latest.get("forge/demo/m2/status")?.value);
  expect(status).not.toBe(2); // alarm came while the machine was still running
});

test("GPU context loss falls back to the list view and comes back", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.locator(".twin canvas").waitFor();
  const ok = await page.evaluate(() => !!document.querySelector<HTMLCanvasElement>(".twin canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context"));
  test.skip(!ok, "no WEBGL_lose_context");
  await page.evaluate(() => { const w = window as unknown as { __lose: { loseContext(): void } }; w.__lose = document.querySelector<HTMLCanvasElement>(".twin canvas")!.getContext("webgl2")!.getExtension("WEBGL_lose_context")!; w.__lose.loseContext(); });
  await expect.poll(async () => (await state(page)).webgl).toBe("lost");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("GPU context was lost");
  await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
  await expect.poll(async () => (await state(page)).webgl).toBe("ok");
});
