// Deep links: branch, selection, view and camera bookmark are in the query string, so any state can be shared and restored.
export interface LinkState { branch?: string; sel?: string; view?: "simulate" | "compare" | "list"; bm?: string; rm?: boolean; enter?: boolean; as?: string; project?: string }

export function readLink(search: string): LinkState {
  const q = new URLSearchParams(search), s: LinkState = {};
  const id = (k: string) => { const v = q.get(k); return v && /^[\w-]{1,40}$/.test(v) ? v : undefined; };
  s.branch = id("branch"); s.sel = id("sel"); s.bm = id("bm"); s.as = id("as"); s.project = id("project");
  const v = q.get("view"); if (v === "simulate" || v === "compare" || v === "list") s.view = v;
  if (q.get("rm") === "1") s.rm = true;
  if (q.get("enter") === "1") s.enter = true;
  for (const k of Object.keys(s) as (keyof LinkState)[]) if (s[k] === undefined) delete s[k];
  return s;
}

export function writeLink(s: LinkState): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== false) q.set(k, v === true ? "1" : String(v));
  const str = q.toString();
  return str ? `?${str}` : "";
}
