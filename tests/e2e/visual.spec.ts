// Visual regression on key motion states: the assembly half way through the first chapter, the assembled line with telemetry,
// and the editor with the expansion branch selected.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test.use({ reducedMotion: "reduce" }); // settled states only (no tween in flight), so frames are comparable

test("assembly, telemetry chapter, editor", async ({ page }) => {
  await ready(page);
  const intro = page.getByLabel("Introduction");
  await intro.evaluate((el) => el.querySelectorAll("[data-chapter]")[1].scrollIntoView());
  await expect.poll(async () => (await state(page)).view).toBe("intro1");
  await page.waitForTimeout(600);
  await expect(page.locator(".twin")).toHaveScreenshot("assembled.png");
  await intro.evaluate((el) => el.querySelectorAll("[data-chapter]")[3].scrollIntoView());
  await expect.poll(async () => (await state(page)).view).toBe("intro3");
  await page.waitForTimeout(600);
  await expect(page.locator(".twin")).toHaveScreenshot("flow-chapter.png", { maxDiffPixelRatio: 0.06 });
  await page.getByRole("button", { name: "Create a factory project" }).click();
  await page.getByRole("combobox", { name: "Camera" }).selectOption("line");
  await page.waitForTimeout(600);
  await expect(page.locator(".twin")).toHaveScreenshot("editor-line.png");
});
