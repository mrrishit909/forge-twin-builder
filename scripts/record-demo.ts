// Records the demo scenario as a captioned video (docs/video/demo.webm; convert with ffmpeg to mp4). Drives the static export
// served by scripts/serve.ts on :8529. Captions are an overlay injected for the recording only.
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";

const url = process.env.URL ?? "http://127.0.0.1:8529/";
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL !== "1", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
mkdirSync("docs/video", { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, recordVideo: { dir: "docs/video", size: { width: 1400, height: 860 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(p: Page, text: string, ms = 3500) {
  await p.evaluate((t) => {
    let el = document.getElementById("rec-caption");
    if (!el) { el = document.createElement("div"); el.id = "rec-caption"; el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99;max-width:820px;padding:10px 16px;border-radius:10px;background:rgba(11,14,19,.9);border:1px solid #5ef2c2;color:#e6ebf2;font:15px/1.4 system-ui;text-align:center;pointer-events:none"; document.body.appendChild(el); }
    el.textContent = t;
  }, text);
  await wait(ms);
}
type W = { __forge: { state: () => Record<string, unknown> & { scenes: Record<string, { assets: { id: string; type: string; transform: { position: number[] } }[] }>; active: string; selected: string }; project: (p: number[]) => [number, number] | null } };
const st = () => page.evaluate(() => (window as unknown as W).__forge.state() as unknown as { selected: string; active: string; scenes: Record<string, { assets: { id: string; type: string; transform: { position: number[] } }[] }> });
const screenOf = (p: [number, number, number]) => page.evaluate((p) => (window as unknown as W).__forge.project(p), p);
async function still() { let last = ""; for (let i = 0; i < 40; i++) { const s = JSON.stringify(await screenOf([0, 0, 0])); if (s === last) return; last = s; await wait(120); } }
async function drop(label: string, at: [number, number, number]) {
  const pt = await screenOf(at);
  await page.locator(".lib-grid button", { hasText: label }).dragTo(page.locator(".twin canvas"), { targetPosition: { x: pt![0], y: pt![1] }, force: true });
}
const outPort = async (id: string) => { const s = await st(); const a = s.scenes[s.active].assets.find((x) => x.id === id)!; const half: Record<string, number> = { conveyor: 2, robot: 0.8, machine: 1 }; return [a.transform.position[0] + half[a.type], 0, a.transform.position[2]] as [number, number, number]; };

await page.goto(url);
await page.waitForFunction(() => (window as unknown as { __forge?: W["__forge"] }).__forge?.state().load.status === "ready", null, { timeout: 60_000 });
await caption(page, "FORGE: a factory digital twin built in the browser. Everything here is synthetic: the plant, its telemetry and the results.", 4500);
const intro = page.getByLabel("Introduction");
const scroll = async (n: number) => { for (let i = 0; i < n; i++) { await intro.evaluate((el) => el.scrollBy(0, 60)); await wait(90); } };
await caption(page, "Scroll, and the line assembles on an empty grid, asset by asset, each one snapped onto the last by its connectors.", 200);
await scroll(32); await wait(2500);
await caption(page, "Telemetry moves the machines: RPM turns the spindles, temperature warms the housings. Nothing animates on its own.", 200);
await scroll(26); await wait(3500);
await caption(page, "Parts flow through a discrete-event simulation of this line.", 200);
await scroll(26); await wait(3500);
await page.getByRole("button", { name: "Create a factory project" }).click();
await caption(page, "The story becomes the project: the same scene, now editable.", 3000);
await page.getByRole("combobox", { name: "Camera" }).selectOption("top");
await still();
await caption(page, "Drag assets in from the library. A conveyor first; then a robot dropped near its end snaps onto the free port and links to it.", 1500);
await drop("Conveyor", [-6, 0, 7]);
const conv = (await st()).selected;
await wait(800);
const p1 = await outPort(conv);
await drop("Robot cell", [p1[0] + 0.5, 0, p1[2] + 0.4]);
await wait(800);
const p2 = await outPort((await st()).selected);
await drop("CNC machine", [p2[0] + 1.3, 0, p2[2] - 0.3]);
await caption(page, "The gizmo moves, rotates and scales with a 0.5 m grid, 15° steps and connector-aware snapping.", 4000);
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Search assets/).pressSequentially("CNC mill M1", { delay: 70 });
await page.keyboard.press("Enter");
await caption(page, "Selecting CNC mill M1 flies the camera to it; the inspector grows out of the machine's place on screen.", 3500);
const insp = page.getByRole("complementary", { name: /Inspector: CNC mill M1/ });
await insp.getByRole("button", { name: "Connect MQTT telemetry" }).click();
await caption(page, "Connect synthetic MQTT telemetry (in this sandbox an in-browser broker; in Docker, Mosquitto with password auth).", 3500);
await insp.locator(".bind-row", { hasText: "RPM" }).getByRole("button").click();
await insp.locator(".bind-row", { hasText: "Temperature" }).getByRole("button").click();
await caption(page, "Bind RPM to the spindle and temperature to the heat glow. Transforms like clamp(value, 20, 120) are parsed, never executed as code.", 7000);
await page.getByRole("button", { name: "Back to overview" }).click();
await page.getByLabel("New branch name").fill("expansion");
await page.getByRole("button", { name: "New branch" }).click();
await still();
await caption(page, "Branch the factory, like version control: on 'expansion' we add a second CNC machine beside M1.", 1500);
await drop("CNC machine", [-7, 0, 3.5]);
const insp2 = page.getByRole("complementary", { name: /Inspector: CNC machine/ });
await insp2.getByLabel("Add an upstream asset").selectOption({ label: "Infeed conveyor" });
await insp2.getByLabel("Add a downstream asset").selectOption({ label: "Buffer B1" });
await caption(page, "Fed by the infeed conveyor, feeding buffer B1: a split and a merge that snapping alone cannot make.", 3500);
await page.getByRole("button", { name: "Back to overview" }).click();
await page.getByRole("button", { name: "Simulate expansion" }).click();
await page.getByRole("complementary", { name: "Simulation results" }).waitFor();
await page.getByRole("button", { name: /Play the first hour/ }).click();
await caption(page, "30 simulated 8-hour shifts in a Web Worker, then the first hour played back at 60×.", 6000);
await page.getByRole("button", { name: "Compare with production" }).click();
await page.getByRole("complementary", { name: "Branch comparison" }).waitFor();
await caption(page, "Against production, with common random numbers: the interval is on the paired difference. The line is now held back by raw-material supply.", 7500);
const pagePromise = ctx.waitForEvent("page");
await page.getByRole("button", { name: /Invite a collaborator/ }).click();
const other = await pagePromise;
await other.waitForFunction(() => ((window as unknown as W).__forge?.state().branches as unknown[] | undefined)?.length === 2, null, { timeout: 30_000 });
await caption(page, "A second collaborator joins (a second tab here): their cursor appears in world space, on the factory floor.", 2000);
for (let i = 0; i < 12; i++) { const pt = await other.evaluate((p) => (window as unknown as W).__forge.project(p), [-9 + i * 0.4, 0, 1.5] as [number, number, number]); if (pt) await other.mouse.move(pt[0], pt[1]); await wait(120); }
await other.getByRole("button", { name: "Comment" }).click();
const cp = await other.evaluate((p) => (window as unknown as W).__forge.project(p), [-5.3, 0, 1.5] as [number, number, number]);
await other.mouse.click(cp![0], cp![1]);
await other.getByRole("form", { name: "New comment" }).getByRole("textbox").fill("Room for a second CNC here? Check the aisle width.");
await other.getByRole("button", { name: "Pin" }).click();
await caption(page, "They pin a comment to a spot on the floor. Edits converge without a server deciding: last writer wins per field, by Lamport clock.", 6000);
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Search assets/).pressSequentially("Press M2", { delay: 60 });
await page.keyboard.press("Enter");
const m2 = page.getByRole("complementary", { name: /Inspector: Press M2/ });
await m2.locator(".bind-row", { hasText: "Vibration" }).getByRole("button").click();
await m2.locator(".bind-row", { hasText: "Status" }).getByRole("button").click();
await caption(page, "Predictive maintenance: each machine's vibration is scored against a baseline learned while it was healthy.", 4500);
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: /bearing fault/ }).click();
await caption(page, "Failure: a bearing in Press M2 starts to fail (the plant clock runs at 20×). Watch the vibration chart.", 12000);
await caption(page, "The detector smooths a robust z-score (median and MAD), so a single spike does not raise an alarm, but a trend does.", 14000);
await page.getByRole("alert").filter({ hasText: /Vibration on Press M2/ }).waitFor({ timeout: 120_000 });
await caption(page, "Alarm, while the press is still running: in 50 simulated runs it came a median of 22 minutes before the trip.", 8000);
await page.getByRole("button", { name: "Back to overview" }).click();
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: /Drop the MQTT broker/ }).click();
await caption(page, "Failure: the MQTT broker drops. Values go stale, the connector backs off and reconnects; retained messages refill the latest values.", 9000);
await page.keyboard.press("l");
await caption(page, "Every asset, link, binding and live value is also in tables: the list view works without WebGL or motion.", 4500);
await page.keyboard.press("l");
await page.getByRole("button", { name: "Telemetry HUD" }).click();
await caption(page, "Telemetry: frame rate, Web Vitals, draw calls, GPU context losses, and the telemetry queue's coalesced and dropped counts.", 5000);
await caption(page, "Synthetic data throughout. Code, tests and the write-up: github.com/mrrishit909/forge-twin-builder.", 4000);
console.log(JSON.stringify(await page.evaluate(() => (window as unknown as { __forge: { telemetry: () => unknown } }).__forge.telemetry())));
const v = page.video();
await other.close();
await ctx.close();
await browser.close();
if (v) renameSync(await v.path(), "docs/video/demo.webm");
console.log("wrote docs/video/demo.webm");
