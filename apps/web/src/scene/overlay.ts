// World-anchored HTML labels (collaborator cursors, comment pins, asset tags): the canvas projects their world positions each
// frame and moves the DOM nodes, so text stays real text (readable by screen readers and crisp at any zoom).
import * as THREE from "three";

export const anchors = new Map<string, { world: THREE.Vector3; el: HTMLElement }>();
export function anchor(id: string, el: HTMLElement | null, world: [number, number, number]) {
  if (!el) { anchors.delete(id); return; }
  anchors.set(id, { world: new THREE.Vector3(...world), el });
}
const v = new THREE.Vector3();
export function projectAnchors(camera: THREE.Camera, w: number, h: number) {
  for (const { world, el } of anchors.values()) {
    v.copy(world).project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    el.style.display = vis ? "" : "none";
    if (vis) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  }
}
/** Shared scene handles for HTML code (drop from the palette, comment placement, shared-element transitions). */
export const sceneApi = {
  pickFloor: (_x: number, _y: number): [number, number, number] | null => null,
  project: (_p: [number, number, number]): [number, number] | null => null,
};
