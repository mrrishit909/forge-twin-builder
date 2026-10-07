// Blueprint 10, section 17: the demo scenario end to end, the way a user does it.
import { expect, test } from "@playwright/test";
import { cameraStill, dropAsset, liveBound, outPort, ready, screenOf, state } from "./helpers.ts";

test("assemble -> project -> drag assets -> MQTT -> bind -> branch -> second machine -> simulate -> compare -> collaborator comment", async ({ page, context }) => {
  await ready(page);
  // 1. the homepage factory assembles from an empty grid as the story scrolls
  await expect(page.getByRole("heading", { name: /Build the factory/ })).toBeVisible();
  const intro = page.getByLabel("Introduction");
  for (const n of [1, 2, 3]) {
    await intro.evaluate((el, k) => el.querySelectorAll("[data-chapter]")[k].scrollIntoView(), n);
    await expect.poll(async () => (await state(page)).view).toBe(`intro${n}`);
  }
  // 2. create a factory project
  await page.getByRole("button", { name: "Create a factory project" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("editor");
  await page.getByRole("combobox", { name: "Camera" }).selectOption("top");
  await cameraStill(page);

  // 3. drag a conveyor, a robot and a machine into the scene; the robot and the machine snap onto the free ports
  const before = (await state(page)).scenes.production.assets.length;
  await dropAsset(page, "Conveyor", [-6, 0, 7]);
  const conv = (await state(page)).selected as string;
  // drop each one a little off the previous asset's out-port: snapping must pull it onto the port and link it
  const p1 = await outPort(page, conv);
  await dropAsset(page, "Robot cell", [p1[0] + 0.5, 0, p1[2] + 0.4]);
  const rid = (await state(page)).selected as string;
  const p2 = await outPort(page, rid);
  await dropAsset(page, "CNC machine", [p2[0] + 1.3, 0, p2[2] - 0.3]);
  let s = await state(page);
  expect(s.scenes.production.assets.length).toBe(before + 3);
  const added = s.scenes.production.assets.filter((a) => a.id.includes("-you-"));
  const robot = added.find((a) => a.type === "robot")!, machine = added.find((a) => a.type === "machine")!;
  expect(s.scenes.production.links).toContainEqual({ from: conv, to: robot.id });
  expect(s.scenes.production.links).toContainEqual({ from: robot.id, to: machine.id });
  expect(robot.transform.position[2]).toBe(7);

  // 4-5. connect synthetic MQTT telemetry and bind RPM and temperature on CNC mill M1
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search assets/).fill("CNC mill M1");
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("complementary", { name: /Inspector: CNC mill M1/ });
  await inspector.getByRole("button", { name: "Connect MQTT telemetry" }).click();
  await expect.poll(async () => ((await state(page)).connector as { state: string }).state).toBe("connected");
  await inspector.locator(".bind-row", { hasText: "RPM" }).getByRole("button").click();
  await inspector.locator(".bind-row", { hasText: "Temperature" }).getByRole("button").click();
  await expect.poll(async () => (await liveBound(page, "m1"))?.spindleRpm !== undefined, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await liveBound(page, "m1"))?.temperatureC ?? 0, { timeout: 15_000 }).toBeGreaterThan(20);
  await expect(inspector.getByText(/RPM \d/)).toBeVisible();

  // 6. expansion branch with a second CNC machine beside M1, fed by the infeed conveyor and feeding buffer B1
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page.getByLabel("New branch name").fill("expansion");
  await page.getByRole("button", { name: "New branch" }).click();
  await expect.poll(async () => (await state(page)).active).toBe("expansion");
  await cameraStill(page);
  await dropAsset(page, "CNC machine", [-7, 0, 3.5]);
  const m1b = (await state(page)).selected as string;
  const insp2 = page.getByRole("complementary", { name: /Inspector: CNC machine/ });
  await insp2.getByLabel("Add an upstream asset").selectOption({ label: "Infeed conveyor" });
  await insp2.getByLabel("Add a downstream asset").selectOption({ label: "Buffer B1" });
  s = await state(page);
  expect(s.scenes.expansion.links).toContainEqual({ from: "c1", to: m1b });
  expect(s.scenes.expansion.links).toContainEqual({ from: m1b, to: "b1" });
  expect(s.scenes.production.assets.some((a) => a.id === m1b)).toBe(false);

  // 7. run the throughput simulation
  await page.getByRole("button", { name: "Back to overview" }).click();
  await page.getByRole("button", { name: "Simulate expansion" }).click();
  await expect(page.getByRole("complementary", { name: "Simulation results" })).toContainText("parts/h", { timeout: 30_000 });
  await page.getByRole("button", { name: /Play the first hour/ }).click();

  // 8. compare KPIs with production, with confidence and assumptions
  await page.getByRole("button", { name: "Compare with production" }).click();
  const cmp = page.getByRole("complementary", { name: "Branch comparison" });
  await expect(cmp).toContainText("parts/h", { timeout: 30_000 });
  const c = (await state(page)).comparison as { throughputDiff: { mean: number; lo: number }; significant: boolean };
  expect(c.significant).toBe(true);
  expect(c.throughputDiff.lo).toBeGreaterThan(5);
  await expect(cmp).toContainText("common random numbers");
  await expect(cmp).toContainText("$240,000");
  await expect.poll(() => page.url()).toContain("view=compare");

  // 9. invite a second collaborator (second tab) who sees the branch and leaves a world-space comment
  const pagePromise = context.waitForEvent("page");
  await page.getByRole("button", { name: /Invite a collaborator/ }).click();
  const other = await pagePromise;
  await expect.poll(async () => (await state(other)).project !== null && ((await state(other)).branches as unknown[] | undefined)?.length, { timeout: 30_000 }).toBe(2);
  await expect(page.getByRole("region", { name: "Collaboration" })).toContainText("collaborator 2", { timeout: 15_000 });
  await other.getByRole("button", { name: "Comment" }).click();
  const pt = await screenOf(other, [-5.3, 0, 1.5]);
  await other.mouse.click(pt![0], pt![1]);
  await other.getByRole("form", { name: "New comment" }).getByRole("textbox").fill("Room for a second CNC here? Check the aisle width.");
  await other.getByRole("button", { name: "Pin" }).click();
  await expect(page.getByRole("region", { name: "Collaboration" })).toContainText("Room for a second CNC here?", { timeout: 10_000 });
  await expect(page.locator(".world-labels .pin")).toHaveCount(1);
  await expect(page.locator(".world-labels .cursor")).toContainText("collaborator 2");

  // deep link restores the comparison after a reload
  const link = page.url();
  await other.close();
  await ready(page, link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByRole("complementary", { name: "Branch comparison" })).toContainText("parts/h", { timeout: 30_000 });
  expect((await state(page)).active).toBe("expansion");
});
