// Per-frame runtime that must not go through React: the motion orchestrator, telemetry, and the simulation playback clock.
import { Orchestrator } from "@forge/motion";
import { Telemetry } from "@forge/telemetry";

export const orchestrator = new Orchestrator();
export const telemetry = new Telemetry((s) => {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (api && typeof navigator !== "undefined") navigator.sendBeacon?.(`${api}/v1/telemetry`, new Blob([JSON.stringify(s)], { type: "application/json" }));
});
/** Simulation playback: seconds into the recorded hour, advanced at `rate` simulated seconds per real second while playing. */
export const playback = { t: 0, playing: false, rate: 60 };
/** Fractional intro chapter 0..3, written by the Intro scroll handler. */
export const introScroll = { f: 0 };
