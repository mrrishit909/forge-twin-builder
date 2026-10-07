// Multiplayer editing: every edit is an operation stamped with a Lamport clock and the author's id. Each (asset, field) is a
// last-writer-wins register ordered by (clock, actor), and a removal beats edits it has seen. Applying the same set of
// operations in any order gives the same scene (tested), so two collaborators converge without a server deciding.
import { canonical, type Asset, type Scene, type V3 } from "./scene.ts";

export type Op =
  | { kind: "add"; asset: Asset; clock: number; actor: string }
  | { kind: "remove"; id: string; clock: number; actor: string }
  | { kind: "set"; id: string; field: "position" | "rotation" | "scale" | "name" | `props.${string}`; value: unknown; clock: number; actor: string };

/** An op before it is stamped with the clock and author. */
export type OpInput = { kind: "add"; asset: Asset } | { kind: "remove"; id: string } | { kind: "set"; id: string; field: "position" | "rotation" | "scale" | "name" | `props.${string}`; value: unknown };

const later = (a: { clock: number; actor: string }, b: { clock: number; actor: string }) => a.clock > b.clock || (a.clock === b.clock && a.actor > b.actor);

export class Replica {
  clock = 0;
  readonly actor: string;
  private adds = new Map<string, Op & { kind: "add" }>();
  private removes = new Map<string, Op & { kind: "remove" }>();
  private regs = new Map<string, Op & { kind: "set" }>();
  private seen = new Set<string>();
  constructor(actor: string, initial?: Scene) {
    this.actor = actor;
    for (const a of initial?.assets ?? []) this.adds.set(a.id, { kind: "add", asset: a, clock: 0, actor: "" });
  }
  /** Make a local op (stamps it) and apply it. */
  local(op: OpInput): Op {
    const o = { ...op, clock: ++this.clock, actor: this.actor } as Op;
    this.apply(o);
    return o;
  }
  apply(o: Op) {
    const key = `${o.actor}:${o.clock}`;
    if (this.seen.has(key)) return; // idempotent: re-delivered ops change nothing
    this.seen.add(key);
    this.clock = Math.max(this.clock, o.clock);
    if (o.kind === "add") { const cur = this.adds.get(o.asset.id); if (!cur || later(o, cur)) this.adds.set(o.asset.id, o); }
    else if (o.kind === "remove") { const cur = this.removes.get(o.id); if (!cur || later(o, cur)) this.removes.set(o.id, o); }
    else { const k = `${o.id}|${o.field}`, cur = this.regs.get(k); if (!cur || later(o, cur)) this.regs.set(k, o); }
  }
  scene(base: Omit<Scene, "assets">): Scene {
    const assets: Asset[] = [];
    for (const [id, add] of [...this.adds].sort(([a], [b]) => a.localeCompare(b))) {
      const rm = this.removes.get(id);
      if (rm && !later(add, rm)) continue; // removed after (or concurrently with a later clock than) its add
      const a: Asset = structuredClone(add.asset);
      for (const [k, s] of this.regs) {
        const [aid, field] = k.split("|");
        if (aid !== id || !later(s, add)) continue;
        if (field === "name") a.name = s.value as string;
        else if (field === "position" || field === "rotation" || field === "scale") a.transform[field] = s.value as V3;
        else a.props[field.slice(6)] = s.value as number;
      }
      assets.push(a);
    }
    return { ...base, assets, links: base.links.filter((l) => assets.some((a) => a.id === l.from) && assets.some((a) => a.id === l.to)) } as Scene;
  }
  digest(base: Omit<Scene, "assets">) { return canonical(this.scene(base)); }
}

export interface Presence { actor: string; name: string; color: string; point: V3 | null; selected: string | null; at: number }
