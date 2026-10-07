"use client";
// The public story: the demo factory assembles itself from an empty grid as you scroll, then telemetry starts moving it, then
// parts flow through it. The same scene becomes the project when you start one.
import { useEffect, useRef } from "react";
import { createProject, get, send, useApp } from "../store.ts";
import { introScroll } from "../runtime.ts";
import { n } from "./fmt.ts";

export default function Intro() {
  const ref = useRef<HTMLDivElement>(null);
  const view = useApp((s) => s.view);
  const tpl = useApp((s) => s.template);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const secs = [...el.querySelectorAll<HTMLElement>("[data-chapter]")];
      const mid = el.scrollTop + el.clientHeight * 0.5;
      let f = 0;
      secs.forEach((s, i) => { if (mid >= s.offsetTop) f = Math.min(3, i + Math.min(1, (mid - s.offsetTop) / s.offsetHeight)); });
      introScroll.f = Math.max(0, f - 0.5);
      const ch = Math.min(3, Math.round(introScroll.f));
      if (get().view.startsWith("intro") && get().view !== `intro${ch}`) send({ type: "CHAPTER", n: ch });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const go = (k: number) => ref.current?.querySelectorAll<HTMLElement>("[data-chapter]")[k]?.scrollIntoView({ behavior: get().reduced ? "auto" : "smooth" });
  const machines = tpl?.assets.filter((a) => a.type === "machine").length ?? 2;
  return (
    <div className="intro" ref={ref} aria-label="Introduction" hidden={!view.startsWith("intro")}>
      <section data-chapter="0" className="chapter">
        <p className="kicker">FORGE · industrial digital twins in the browser</p>
        <h1>Build the factory, wire it to the floor, try the change before you buy it.</h1>
        <p>An empty grid. Scroll, and a production line assembles on it from the asset library: every piece is a real, editable asset with connectors.</p>
        <p className="badge-line"><span className="badge">SYNTHETIC DATA</span> The plant, its telemetry and every number here come from simulators in this repository.</p>
        <button className="ghost" onClick={() => go(1)}>Start</button>
      </section>
      <section data-chapter="1" className="chapter">
        <h2>{tpl ? n(tpl.assets.length) : 8} assets, port to port.</h2>
        <p>Raw material, an infeed conveyor, a CNC mill, a buffer rack, a robot cell, a press, an outfeed conveyor and finished goods. Each one snapped onto the last by its connectors.</p>
      </section>
      <section data-chapter="2" className="chapter">
        <h2>Telemetry moves the machines.</h2>
        <p>The {machines} machines publish RPM, temperature, vibration, flow and status. Bound to the model, RPM turns the spindles and temperature colours the housings. Nothing here animates on its own.</p>
      </section>
      <section data-chapter="3" className="chapter">
        <h2>Then ask it a question.</h2>
        <p>Parts flow through a discrete-event simulation of this line. Where does it jam, and what would a second CNC machine buy you? Branch it, simulate it, compare it, with confidence intervals.</p>
        <div className="cta">
          <button className="primary" onClick={() => createProject()}>Create a factory project</button>
        </div>
      </section>
    </div>
  );
}
