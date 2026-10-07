// Branches work like version control for scenes: a branch keeps the snapshot it started from, so a merge back is three-way.
// A field changed only on one side is taken; changed on both sides to different values is a conflict the user must resolve.
import { canonical, type Asset, type Link, type Scene } from "./scene.ts";

export interface Branch { id: string; name: string; parentId: string | null; base: Scene; scene: Scene; createdBy: string; createdAt: string }
export type Change =
  | { kind: "added"; asset: Asset } | { kind: "removed"; id: string }
  | { kind: "changed"; id: string; field: string; from: unknown; to: unknown }
  | { kind: "linked"; link: Link } | { kind: "unlinked"; link: Link };

const fields = (a: Asset): Record<string, unknown> => ({ name: a.name, position: a.transform.position, rotation: a.transform.rotation, scale: a.transform.scale, ...Object.fromEntries(Object.entries(a.props).map(([k, v]) => [`props.${k}`, v])) });
const lk = (l: Link) => `${l.from}->${l.to}`;

export function branchFrom(parent: Scene | Branch, id: string, name: string, by: string, at = new Date().toISOString()): Branch {
  const scene = "scene" in parent ? parent.scene : parent;
  return { id, name, parentId: "scene" in parent ? parent.id : null, base: structuredClone(scene), scene: structuredClone(scene), createdBy: by, createdAt: at };
}

export function diff(a: Scene, b: Scene): Change[] {
  const out: Change[] = [];
  const A = new Map(a.assets.map((x) => [x.id, x])), B = new Map(b.assets.map((x) => [x.id, x]));
  for (const [id, x] of B) if (!A.has(id)) out.push({ kind: "added", asset: x });
  for (const id of A.keys()) if (!B.has(id)) out.push({ kind: "removed", id });
  for (const [id, x] of A) {
    const y = B.get(id); if (!y) continue;
    const fx = fields(x), fy = fields(y);
    for (const f of new Set([...Object.keys(fx), ...Object.keys(fy)])) if (canonical(fx[f]) !== canonical(fy[f])) out.push({ kind: "changed", id, field: f, from: fx[f], to: fy[f] });
  }
  const la = new Set(a.links.map(lk)), lb = new Set(b.links.map(lk));
  for (const l of b.links) if (!la.has(lk(l))) out.push({ kind: "linked", link: l });
  for (const l of a.links) if (!lb.has(lk(l))) out.push({ kind: "unlinked", link: l });
  return out;
}

const setField = (a: Asset, f: string, v: unknown) => {
  if (f === "name") a.name = v as string;
  else if (f === "position" || f === "rotation" || f === "scale") a.transform[f] = v as [number, number, number];
  else if (f.startsWith("props.")) { if (v === undefined) delete a.props[f.slice(6)]; else a.props[f.slice(6)] = v as number; }
};

export interface Conflict { id: string; field: string; ours: unknown; theirs: unknown }

/** Merge `source` into `target`, both having started from `base`. Conflicts are reported and the target's value kept. */
export function merge(base: Scene, target: Scene, source: Scene): { scene: Scene; conflicts: Conflict[]; applied: number } {
  const ours = diff(base, target), theirs = diff(base, source);
  const ourKey = new Map(ours.filter((c) => c.kind === "changed").map((c) => [`${(c as { id: string }).id}:${(c as { field: string }).field}`, c]));
  const removedByUs = new Set(ours.filter((c) => c.kind === "removed").map((c) => (c as { id: string }).id));
  const out = structuredClone(target);
  const conflicts: Conflict[] = [];
  let applied = 0;
  for (const c of theirs) {
    if (c.kind === "added") { if (!out.assets.some((a) => a.id === c.asset.id)) { out.assets.push(structuredClone(c.asset)); applied++; } }
    else if (c.kind === "removed") {
      if (ours.some((o) => o.kind === "changed" && o.id === c.id)) { conflicts.push({ id: c.id, field: "(removed)", ours: "changed", theirs: "removed" }); continue; }
      out.assets = out.assets.filter((a) => a.id !== c.id); out.links = out.links.filter((l) => l.from !== c.id && l.to !== c.id); applied++;
    } else if (c.kind === "changed") {
      if (removedByUs.has(c.id)) { conflicts.push({ id: c.id, field: c.field, ours: "(removed)", theirs: c.to }); continue; }
      const o = ourKey.get(`${c.id}:${c.field}`) as { to: unknown } | undefined;
      if (o && canonical(o.to) !== canonical(c.to)) { conflicts.push({ id: c.id, field: c.field, ours: o.to, theirs: c.to }); continue; }
      const a = out.assets.find((x) => x.id === c.id);
      if (a) { setField(a, c.field, structuredClone(c.to)); applied++; }
    } else if (c.kind === "linked") { if (!out.links.some((l) => lk(l) === lk(c.link)) && out.assets.some((a) => a.id === c.link.from) && out.assets.some((a) => a.id === c.link.to)) { out.links.push(c.link); applied++; } }
    else if (c.kind === "unlinked") { out.links = out.links.filter((l) => lk(l) !== lk(c.link)); applied++; }
  }
  return { scene: out, conflicts, applied };
}
