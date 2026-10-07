/** Deterministic uuid-shaped id from a number (stable across runs and databases). */
export function uuidFor(kind: number, n: number) {
  const h = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  let a = (n * 2654435761) ^ (kind * 40503);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  const b = Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ kind;
  return `${h(a)}-${h(n).slice(4)}-4${h(kind).slice(5)}-8${h(b).slice(5)}-${h(b ^ a)}${h(n).slice(4)}`;
}
