"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@forge/motion";
import type { AssetType, V3 } from "@forge/domain";
import { activeScene, addAsset, backend, commitTransform, compareWithProduction, createProject, get, init, raiseAlert, removeAsset, select, send, set, simulate, switchBranch, useApp } from "./store.ts";
import { readLink, writeLink } from "./url.ts";
import { isIntro } from "./journey.ts";
import { live, onAlarm } from "./live.ts";
import { telemetry } from "./runtime.ts";
import { sceneApi } from "./scene/overlay.ts";
import Intro from "./ui/Intro.tsx";
import { Banner, Branches, Collaboration, CommentForm, ComparePanel, Inspector, Library, SimulationPanel, TelemetryControls, TopBar, WorldLabels } from "./ui/Sandbox.tsx";
import { Help, Palette } from "./ui/Dialogs.tsx";
import ListView from "./ui/ListView.tsx";
import Hud from "./ui/Hud.tsx";

const Scene = dynamic(() => import("./scene/Scene.tsx"), { ssr: false });
const hasWebGL = () => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } };

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.closest?.("dialog")) return;
      const s = get();
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") { e.preventDefault(); set({ palette: true }); return; }
      if (isIntro(s.view) || e.metaKey || e.ctrlKey || e.altKey) return;
      const sc = activeScene(), a = sc?.assets.find((x) => x.id === s.selected);
      if (a && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const t = structuredClone(a.transform);
        if (e.shiftKey) t.rotation[1] = (t.rotation[1] + (e.key === "ArrowLeft" ? 15 : e.key === "ArrowRight" ? -15 : 0) + 360) % 360;
        else { const d = { ArrowLeft: [-0.5, 0], ArrowRight: [0.5, 0], ArrowUp: [0, -0.5], ArrowDown: [0, 0.5] }[e.key]!; t.position = [t.position[0] + d[0], t.position[1], t.position[2] + d[1]] as V3; }
        commitTransform(a.id, t);
        return;
      }
      const ids = sc?.assets.map((x) => x.id) ?? [], at = ids.indexOf(s.selected ?? "");
      switch (e.key) {
        case "w": case "W": set({ tool: "translate" }); break;
        case "e": case "E": set({ tool: "rotate" }); break;
        case "r": case "R": set({ tool: "scale" }); break;
        case "]": if (ids.length) select(ids[(at + 1) % ids.length]); break;
        case "[": if (ids.length) select(ids[(at - 1 + ids.length) % ids.length]); break;
        case "Delete": case "Backspace": if (a) removeAsset(a.id); break;
        case "s": case "S": void simulate(); break;
        case "l": case "L": set({ listView: !s.listView }); break;
        case "m": case "M": set({ reduced: !s.reduced }); break;
        case "p": case "P": set({ motionPaused: !s.motionPaused }); break;
        case "?": set({ help: true }); break;
        case "Escape": if (s.placing || s.commentMode) set({ placing: null, commentMode: false }); else if (s.selected) select(null); else send({ type: "BACK" }); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Restore state from the URL once the project exists, then keep the URL in step with the state. */
function useDeepLink() {
  const project = useApp((s) => s.project);
  const applied = useRef(false);
  useEffect(() => {
    if (!project || applied.current) return;
    applied.current = true;
    const l = readLink(location.search);
    if (l.bm) set({ bookmark: l.bm });
    if (l.view === "list") set({ listView: true });
    if (l.branch && l.branch !== "production") {
      const wait = setInterval(() => { if (get().branches.some((b) => b.id === l.branch)) { clearInterval(wait); switchBranch(l.branch!); if (l.view === "compare") void compareWithProduction(); else if (l.view === "simulate") void simulate(); if (l.sel) select(l.sel); } }, 200);
      setTimeout(() => clearInterval(wait), 8000);
    } else { if (l.view === "simulate") void simulate(); if (l.sel) select(l.sel); }
    let last = "";
    setInterval(() => {
      const s = get();
      if (isIntro(s.view)) return;
      const link = writeLink({ as: s.me.actor !== "you" ? s.me.actor : undefined, project: backend.kind === "api" || s.me.actor !== "you" ? s.project?.id : undefined, enter: true, branch: s.active !== "production" ? s.active : undefined, sel: s.selected ?? undefined, view: s.view === "simulate" || s.view === "compare" ? s.view : s.listView ? "list" : undefined, bm: s.bookmark !== "overview" ? s.bookmark : undefined, rm: s.reduced || undefined });
      if (link !== last) { last = link; history.replaceState(null, "", link); }
    }, 400);
  }, [project]);
}

export default function App() {
  const view = useApp((s) => s.view), listView = useApp((s) => s.listView), webgl = useApp((s) => s.webgl), load = useApp((s) => s.load);
  const announce = useApp((s) => s.announce), reduced = useApp((s) => s.reduced), project = useApp((s) => s.project), placing = useApp((s) => s.placing), commentMode = useApp((s) => s.commentMode);
  useKeyboard();
  useDeepLink();
  useEffect(() => {
    const l = readLink(location.search);
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    set({ reduced: prefersReducedMotion() || l.rm === true, webgl: hasWebGL() ? "ok" : "unsupported" });
    const onChange = () => set({ reduced: mq.matches });
    mq.addEventListener("change", onChange);
    telemetry.start();
    onAlarm((asset, score) => raiseAlert(`Vibration on ${activeScene()?.assets.find((a) => a.id === asset)?.name ?? asset} is ${score.toFixed(1)} robust standard deviations above its healthy baseline: a bearing may be failing. Plan maintenance before it trips.`));
    void init({ actor: l.as, project: l.project }).then(() => { if ((l.enter || l.as) && !l.project) void createProject(); });
    (window as unknown as { __forge: unknown }).__forge = { state: get, live, telemetry: () => telemetry.s, project: (p: [number, number, number]) => sceneApi.project(p) };
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { document.documentElement.dataset.reduced = reduced ? "1" : "0"; }, [reduced]);
  const intro = isIntro(view), show3d = !listView && webgl === "ok";
  const onDrop = (e: React.DragEvent) => {
    const t = e.dataTransfer.getData("text/forge-asset") as AssetType;
    if (!t) return;
    e.preventDefault();
    const p = sceneApi.pickFloor(e.clientX, e.clientY);
    if (p) addAsset(t, p);
  };
  return (
    <div className={`app view-${view} ${intro ? "is-intro" : "is-sandbox"} ${placing ? "is-placing" : ""} ${commentMode ? "is-commenting" : ""}`}>
      <a className="skip" href="#main-panels">Skip to the panels</a>
      {webgl !== "unsupported" ? <div className="twin-wrap" style={{ visibility: show3d || intro ? "visible" : "hidden" }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}><Scene /></div> : null}
      <WorldLabels />
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {load.status === "error" ? <div className="banner warn" role="alert">Could not load the factory template: {load.message}. <button onClick={() => location.reload()}>Retry</button></div> : null}
      <Intro />
      {!intro && project ? (
        <>
          <TopBar />
          <Banner />
          <div id="main-panels" className="panels">
            <aside className="panel left" aria-label="Project">
              <Library />
              <TelemetryControls />
              <Branches />
              <Collaboration />
            </aside>
            {listView || webgl !== "ok" ? <ListView /> : null}
            <Inspector />
            <SimulationPanel />
            <ComparePanel />
          </div>
          <CommentForm />
          <Hud />
        </>
      ) : null}
      <Palette />
      <Help />
    </div>
  );
}
