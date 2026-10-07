// Copies the generated fixtures into the web app's public folder (the static sandbox reads them from /data/).
import { cpSync, existsSync, mkdirSync } from "node:fs";
const src = new URL("../data/fixtures/", import.meta.url), dst = new URL("../apps/web/public/data/", import.meta.url);
if (!existsSync(new URL("template-scene.json", src))) throw new Error("run `make seed` (node data/simulators/generate.ts) first");
mkdirSync(dst, { recursive: true });
for (const f of ["template-scene.json", "evaluation.json", "provenance.json"]) cpSync(new URL(f, src), new URL(f, dst));
console.log("fixtures copied to apps/web/public/data");
