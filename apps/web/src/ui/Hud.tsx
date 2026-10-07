"use client";
import { useEffect, useState } from "react";
import type { Snapshot } from "@forge/telemetry";
import { telemetry } from "../runtime.ts";
import { useApp } from "../store.ts";
import { live } from "../live.ts";
import { n } from "./fmt.ts";

export default function Hud() {
  const on = useApp((s) => s.hud);
  const stress = useApp((s) => s.stressInfo);
  const conn = useApp((s) => s.connector.state);
  const [s, setS] = useState<Snapshot>(telemetry.s);
  useEffect(() => { const off = telemetry.subscribe(setS); return () => { off(); }; }, []);
  if (!on) return null;
  const r = s.render;
  const rows: [string, string][] = [
    ["FPS", `${s.fps} (p95 frame ${s.frameP95Ms} ms)`], ["Dropped frames", n(s.droppedFrames)], ["Long tasks", n(s.longTasks)],
    ["LCP / INP / CLS", `${s.lcpMs ?? "–"} ms / ${s.inpMs ?? "–"} ms / ${s.cls ?? "–"}`],
    ["Scene load", `${s.sceneLoadMs ?? "–"} ms`], ["Shader compile", `${s.shaderCompileMs ?? "–"} ms`],
    ["Draw calls / triangles", r ? `${r.calls} / ${n(r.triangles)}` : "–"], ["Points drawn", r ? n(r.points) : "–"],
    ["GPU geometries / textures / programs", r ? `${r.geometries} / ${r.textures} / ${r.programs}` : "–"],
    ["Assets drawn", n(s.objects)], ["LOD near / far", stress ? `${n(stress.near)} / ${n(stress.far)}` : "–"], ["GPU context lost", String(s.contextLost)],
    ["Telemetry", `${conn} · ${n(live.received)} received · queue ${live.queue.size} · coalesced ${n(live.queue.coalesced)} · dropped ${n(live.queue.dropped)}`],
  ];
  return (
    <aside className="hud" aria-label="Telemetry">
      <table><tbody>{rows.map(([a, b]) => <tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table>
    </aside>
  );
}
