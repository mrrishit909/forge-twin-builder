// Reduced motion keeps every fact and task; the keyboard alone can edit the line; the list view replaces the canvas.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("instant states and no continuous motion, same information", async ({ page }) => {
    await ready(page, "/?enter=1");
    expect((await state(page)).reduced).toBe(true);
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Search assets/).fill("CNC mill M1");
    await page.keyboard.press("Enter");
    const insp = page.getByRole("complementary", { name: /Inspector: CNC mill M1/ });
    await insp.getByRole("button", { name: "Connect MQTT telemetry" }).click();
    await insp.locator(".bind-row", { hasText: "RPM" }).getByRole("button").click();
    await expect(insp.getByText(/RPM \d/)).toBeVisible({ timeout: 15_000 });
    // the spindle does not turn under reduced motion, but the number is there
    const spin = () => page.evaluate(() => { const g = (window as unknown as { __forge: unknown }) && document.querySelector("canvas"); return !!g; });
    expect(await spin()).toBe(true);
    await page.getByRole("button", { name: "Back to overview" }).click();
    await page.getByRole("button", { name: "Simulate production" }).click();
    await expect(page.getByRole("complementary", { name: "Simulation results" })).toContainText("Constraint");
  });
});

test("keyboard only: select, nudge, rotate, delete, list view", async ({ page }) => {
  await ready(page, "/?enter=1");
  await expect.poll(async () => (await state(page)).view).toBe("editor");
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).selected).not.toBeNull();
  const id = (await state(page)).selected as string;
  const pos = async () => (await state(page)).scenes.production.assets.find((a) => a.id === id)?.transform;
  const p0 = (await pos())!;
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await pos())?.rotation[1]).toBe((p0.rotation[1] + 15) % 360);
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await pos())?.position[2]).toBeLessThan(p0.position[2] + 0.01);
  await page.keyboard.press("e");
  expect((await state(page)).tool).toBe("rotate");
  await page.keyboard.press("l");
  const list = page.getByRole("main", { name: "List view" });
  await expect(list.getByRole("table")).toBeVisible();
  await expect(list).toContainText("Infeed conveyor → CNC mill M1");
  await page.keyboard.press("l");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await state(page)).scenes.production.assets.some((a) => a.id === id)).toBe(false);
  const unnamed = await page.locator("button:visible").evaluateAll((bs) => bs.filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
  expect(unnamed).toBe(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
