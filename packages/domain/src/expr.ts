// Binding transforms such as "value / 60" or "clamp(value, 20, 120)". A tiny recursive-descent parser: numbers, `value`,
// + - * / ( ), unary minus and four functions. Nothing is ever passed to eval or Function, so a binding cannot run code.

type Node = { k: "num"; v: number } | { k: "var" } | { k: "neg"; a: Node } | { k: "bin"; op: string; a: Node; b: Node } | { k: "fn"; name: string; args: Node[] };
const FNS: Record<string, [number, (...x: number[]) => number]> = {
  min: [2, Math.min], max: [2, Math.max], abs: [1, Math.abs], clamp: [3, (x, lo, hi) => Math.min(hi, Math.max(lo, x))],
};

export class ExprError extends Error {}

export function compile(src: string): (value: number) => number {
  if (src.length > 120) throw new ExprError("expression too long");
  const toks = src.match(/\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]+|[-+*/(),])/gy);
  if (!toks || toks.join("").replace(/\s/g, "") !== src.replace(/\s/g, "")) throw new ExprError(`unexpected character in "${src}"`);
  const t = toks.map((x) => x.trim());
  let i = 0;
  const peek = () => t[i], eat = (x?: string) => { const v = t[i++]; if (x && v !== x) throw new ExprError(`expected ${x}`); return v; };
  const primary = (): Node => {
    const x = eat();
    if (x === undefined) throw new ExprError("unexpected end");
    if (x === "(") { const n = sum(); eat(")"); return n; }
    if (x === "-") return { k: "neg", a: primary() };
    if (/^[\d.]/.test(x)) return { k: "num", v: Number(x) };
    if (x === "value") return { k: "var" };
    if (x in FNS) {
      eat("(");
      const args = [sum()];
      while (peek() === ",") { eat(","); args.push(sum()); }
      eat(")");
      if (args.length !== FNS[x][0]) throw new ExprError(`${x} takes ${FNS[x][0]} arguments`);
      return { k: "fn", name: x, args };
    }
    throw new ExprError(`unknown name "${x}"`);
  };
  const product = (): Node => { let n = primary(); while (peek() === "*" || peek() === "/") { const op = eat(); n = { k: "bin", op, a: n, b: primary() }; } return n; };
  const sum = (): Node => { let n = product(); while (peek() === "+" || peek() === "-") { const op = eat(); n = { k: "bin", op, a: n, b: product() }; } return n; };
  const ast = sum();
  if (i !== t.length) throw new ExprError(`unexpected "${t[i]}"`);
  const ev = (n: Node, v: number): number => {
    switch (n.k) {
      case "num": return n.v;
      case "var": return v;
      case "neg": return -ev(n.a, v);
      case "fn": return FNS[n.name][1](...n.args.map((a) => ev(a, v)));
      case "bin": { const a = ev(n.a, v), b = ev(n.b, v); return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : a / b; }
    }
  };
  return (v) => ev(ast, v);
}
