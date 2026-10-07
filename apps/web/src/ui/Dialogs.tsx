"use client";
// Command palette and keyboard help. Native <dialog> for focus trapping and Escape.
import { useEffect, useMemo, useRef, useState } from "react";
import { LIBRARY, type AssetType } from "@forge/domain";
import { activeScene, compareWithProduction, connectTelemetry, createProject, newBranch, select, set, simulate, switchBranch, useApp, invite } from "../store.ts";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const c = () => onClose();
    d.addEventListener("close", c);
    return () => d.removeEventListener("close", c);
  }, [open, onClose]);
  return ref;
}

export function Palette() {
  const open = useApp((s) => s.palette);
  const close = useMemo(() => () => set({ palette: false }), []);
  const ref = useDialog(open, close);
  const [q, setQ] = useState("");
  const [k, setK] = useState(0);
  const scene = useApp((s) => s.scenes[s.active]);
  const branches = useApp((s) => s.branches);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const assets = (scene?.assets ?? []).filter((a) => !t || a.name.toLowerCase().includes(t) || a.id.includes(t)).slice(0, 8).map((a) => ({ label: `${a.name} · ${LIBRARY[a.type].label}`, run: () => select(a.id) }));
    const actions = [
      { label: "Create a factory project", run: () => createProject() },
      { label: "Connect MQTT telemetry", run: () => connectTelemetry() },
      { label: "Simulate this branch", run: () => simulate() },
      { label: "Compare with production", run: () => compareWithProduction() },
      { label: "New branch: expansion", run: () => newBranch("expansion") },
      ...branches.map((b) => ({ label: `Switch to branch ${b.name}`, run: () => switchBranch(b.id) })),
      ...(Object.keys(LIBRARY) as AssetType[]).map((ty) => ({ label: `Place ${LIBRARY[ty].label}`, run: () => set({ placing: ty }) })),
      { label: "Invite a collaborator", run: () => invite() },
      { label: "Toggle list view", run: () => set((s) => ({ listView: !s.listView })) },
      { label: "Toggle reduced motion", run: () => set((s) => ({ reduced: !s.reduced })) },
    ].filter((a) => !t || a.label.toLowerCase().includes(t));
    return [...assets, ...actions];
  }, [q, scene, branches]);
  const run = (i: number) => { items[i]?.run(); set({ palette: false }); setQ(""); };
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Command palette">
      <input autoFocus placeholder="Search assets, branches, actions…" value={q} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={`pi-${k}`}
        onChange={(e) => { setQ(e.target.value); setK(0); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setK(Math.min(items.length - 1, k + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setK(Math.max(0, k - 1)); } if (e.key === "Enter") { e.preventDefault(); run(k); } }} />
      <ul id="palette-list" role="listbox">{items.map((it, i) => <li key={i} id={`pi-${i}`} role="option" aria-selected={i === k}><button onClick={() => run(i)}>{it.label}</button></li>)}</ul>
    </dialog>
  );
}

export function Help() {
  const open = useApp((s) => s.help);
  const close = useMemo(() => () => set({ help: false }), []);
  const ref = useDialog(open, close);
  const keys = [["⌘K / Ctrl K / /", "search and commands"], ["W E R", "gizmo: move, rotate, scale"], ["Arrow keys", "nudge the selected asset 0.5 m (Shift: rotate 15°)"], ["Delete", "remove the selected asset"], ["[ ]", "previous / next asset"], ["S", "simulate the branch"], ["L", "list view"], ["M", "reduced motion"], ["P", "pause all motion"], ["Esc", "deselect / back"]];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard</h2>
      <table><tbody>{keys.map(([a, b]) => <tr key={a}><th scope="row"><kbd>{a}</kbd></th><td>{b}</td></tr>)}</tbody></table>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
export const _unused = activeScene;
