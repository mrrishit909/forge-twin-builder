"use client";
// Text-and-table alternative to the 3D scene: every asset, link, binding, live value and result, without WebGL or motion.
import { LIBRARY, topicOf } from "@forge/domain";
import { select, useApp } from "../store.ts";
import { valueOf } from "../live.ts";

export default function ListView() {
  const scene = useApp((s) => s.scenes[s.active] ?? s.template);
  const active = useApp((s) => s.active), webgl = useApp((s) => s.webgl), sim = useApp((s) => s.sims[s.active]);
  useApp((s) => s.connector.state);
  if (!scene) return null;
  const name = (id: string) => scene.assets.find((a) => a.id === id)?.name ?? id;
  return (
    <main className="listview" aria-label="List view">
      {webgl !== "ok" ? <p className="banner warn" role="status">{webgl === "lost" ? "The GPU context was lost. The 3D view comes back when the browser restores it; everything is here meanwhile." : "This browser has no WebGL, so the twin is shown as tables."}</p> : null}
      <h2>Assets on {active}</h2>
      <div className="table-wrap"><table>
        <caption>{scene.assets.length} assets, {scene.links.length} links</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Position (m)</th><th scope="col">Rotation</th><th scope="col">RPM</th><th scope="col">°C</th><th scope="col">Vibration</th><th scope="col" /></tr></thead>
        <tbody>{scene.assets.map((a) => (
          <tr key={a.id}><td>{a.name}</td><td>{LIBRARY[a.type].label}</td><td>{a.transform.position.map((x) => x.toFixed(1)).join(", ")}</td><td>{a.transform.rotation[1]}°</td>
            {(["rpm", "temperature", "vibration"] as const).map((m) => { const v = valueOf(topicOf("demo", a.id, m)); return <td key={m}>{v === undefined ? "–" : v.toFixed(m === "rpm" ? 0 : 1)}</td>; })}
            <td><button onClick={() => select(a.id)}>Inspect</button></td></tr>
        ))}</tbody>
      </table></div>
      <h2>Flow</h2>
      <ol>{scene.links.map((l) => <li key={`${l.from}-${l.to}`}>{name(l.from)} → {name(l.to)}</li>)}</ol>
      <h2>Bindings</h2>
      <ul>{scene.bindings.length ? scene.bindings.map((b) => <li key={b.id}><code>{b.sourcePath}</code> → {name(b.assetId)}.{b.targetProperty} via <code>{b.transform}</code></li>) : <li>None yet.</li>}</ul>
      {sim ? <><h2>Last simulation</h2><p>{sim.kpis.throughputPerH.mean.toFixed(1)} parts/h (95% interval {sim.kpis.throughputPerH.lo.toFixed(1)}–{sim.kpis.throughputPerH.hi.toFixed(1)}), bottleneck {name(sim.kpis.bottleneck[0].id)}.</p></> : null}
    </main>
  );
}
