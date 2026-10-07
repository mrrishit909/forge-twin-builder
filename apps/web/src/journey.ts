// The product's views as a deterministic machine (packages/motion). The store asks it which view follows an event; the
// scene then animates camera bookmarks and the intro assembly toward that view. Reduced motion changes speed, never the path.
import { transition, type MachineDef } from "@forge/motion";

export type View = "intro0" | "intro1" | "intro2" | "intro3" | "editor" | "inspect" | "simulate" | "compare";
export type JourneyEvent = { type: "CHAPTER"; n: number } | { type: "ENTER" } | { type: "SELECT" } | { type: "DESELECT" } | { type: "SIMULATE" } | { type: "COMPARE" } | { type: "BACK" };

const intro = (n: number): View => (["intro0", "intro1", "intro2", "intro3"] as const)[Math.max(0, Math.min(3, n))];
const introState = { on: { CHAPTER: (e: { n: number }) => intro(e.n), ENTER: "editor" as View } };
export const journey: MachineDef<View, JourneyEvent> = {
  initial: "intro0",
  states: {
    intro0: introState, intro1: introState, intro2: introState, intro3: introState,
    editor: { on: { SELECT: "inspect", SIMULATE: "simulate", COMPARE: "compare", CHAPTER: (e) => intro(e.n) } },
    inspect: { on: { SELECT: "inspect", DESELECT: "editor", BACK: "editor", SIMULATE: "simulate", COMPARE: "compare" } },
    simulate: { on: { BACK: "editor", SELECT: "inspect", COMPARE: "compare", SIMULATE: "simulate" } },
    compare: { on: { BACK: "editor", SELECT: "inspect", SIMULATE: "simulate" } },
  },
};
export const next = (v: View, e: JourneyEvent) => transition(journey, v, e);
export const isIntro = (v: View) => v.startsWith("intro");

/** Camera bookmarks (target xyz, distance, azimuth, elevation). The intro moves between them by scroll. */
export type Cam = [number, number, number, number, number, number];
export const BOOKMARKS: Record<string, Cam> = {
  intro0: [-4, 0, 0, 34, 0.9, 1.05], intro1: [-4, 0, 0, 22, 0.75, 0.62], intro2: [-4.5, 1, 0, 15, 0.5, 0.42], intro3: [-4, 0.5, 1, 18, 0.3, 0.5],
  overview: [-4, 0, 1, 20, 0.55, 0.62], line: [-4, 1, 0, 12, 0.05, 0.25], top: [-4, 0, 1, 26, 0, 1.45],
};
