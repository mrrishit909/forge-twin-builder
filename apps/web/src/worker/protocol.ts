// Messages between the page and the simulation worker (discrete-event runs are the heavy part of the sandbox).
import type { Kpis, Scene, SimResult, Estimate } from "@forge/domain";

export type KpisOut = Omit<Kpis, never>;
export type ToWorker =
  | { type: "simulate"; id: number; scene: Scene; reps: number }
  | { type: "compare"; id: number; base: Scene; branch: Scene; reps: number }
  | { type: "optimize"; id: number; scene: Scene; bufferId: string };

export type FromWorker =
  | { type: "simulate"; id: number; kpis: KpisOut; playback: SimResult; ms: number }
  | { type: "compare"; id: number; base: KpisOut; branch: KpisOut; throughputDiff: Estimate; significant: boolean; ms: number }
  | { type: "optimize"; id: number; rows: { capacity: number; throughputPerH: number }[]; chosen: number; best: number; ms: number }
  | { type: "error"; id: number; message: string };
