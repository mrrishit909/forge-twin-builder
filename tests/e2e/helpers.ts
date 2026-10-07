import { expect, type Page } from "@playwright/test";

type S = Record<string, unknown> & { scenes: Record<string, { assets: { id: string; name: string; type: string; transform: { position: number[]; rotation: number[] } }[]; links: { from: string; to: string }[]; bindings: unknown[] }>; active: string };
export const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { __forge?: { state: () => Record<string, unknown> } }).__forge;
  if (!h) return { view: null, load: { status: "booting" } } as Record<string, unknown>;
  const s = h.state() as Record<string, unknown>;
  return JSON.parse(JSON.stringify({ ...s, branches: (s.branches as { id: string; name: string }[]).map((b) => ({ id: b.id, name: b.name })) }));
}) as Promise<S>;
export async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect.poll(async () => ((await state(page)).load as { status: string })?.status, { timeout: 30_000 }).toBe("ready");
}
/** Screen point of a world position (for dropping assets and clicking the floor). */
export const screenOf = (page: Page, p: [number, number, number]) => page.evaluate((p) => (window as unknown as { __forge: { project: (p: number[]) => [number, number] | null } }).__forge.project(p), p);
export const liveBound = (page: Page, id: string) => page.evaluate((id) => (window as unknown as { __forge: { live: { bound: Map<string, Record<string, number>> } } }).__forge.live.bound.get(id) ?? null, id);
export async function dropAsset(page: Page, label: string, at: [number, number, number]) {
  const pt = await screenOf(page, at);
  if (!pt) throw new Error("drop point off screen");
  await page.locator(`.lib-grid button`, { hasText: label }).dragTo(page.locator(".twin canvas"), { targetPosition: { x: pt[0], y: pt[1] } });
}
/** Wait until the camera has stopped moving (a fixed world point projects to the same pixel twice in a row). */
export async function cameraStill(page: Page) {
  let last = "";
  for (let i = 0; i < 60; i++) {
    const p = JSON.stringify(await screenOf(page, [0, 0, 0]));
    if (p === last) return;
    last = p;
    await page.waitForTimeout(150);
  }
}
/** World position of an asset's out-port (from the scene in the page). */
export const outPort = (page: Page, id: string) => page.evaluate((id) => {
  const s = (window as unknown as { __forge: { state: () => { scenes: Record<string, { assets: { id: string; type: string; transform: { position: number[] } }[] }>; active: string } } }).__forge.state();
  const a = s.scenes[s.active].assets.find((x) => x.id === id)!;
  const half: Record<string, number> = { conveyor: 2, robot: 0.8, machine: 1, buffer: 0.7, source: 0.6 };
  return [a.transform.position[0] + half[a.type], 0, a.transform.position[2]] as [number, number, number];
}, id);
