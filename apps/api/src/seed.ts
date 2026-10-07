// Demo tenants and tokens (local only; printed in the README). Projects are created through the API.
import pg from "pg";
import { uuidFor } from "./ids.ts";
import { sha256 } from "./db.ts";

export const ORGS = [
  { id: uuidFor(9, 1), slug: "acme", name: "Acme Machining", plan: "factory" },
  { id: uuidFor(9, 2), slug: "globex", name: "Globex Assembly", plan: "builder" },
] as const;
export const TOKENS = [
  { token: "acme-engineer-demo", org: "acme", role: "engineer" },
  { token: "acme-viewer-demo", org: "acme", role: "viewer" },
  { token: "globex-engineer-demo", org: "globex", role: "engineer" },
] as const;

export async function seed(url = process.env.OWNER_DATABASE_URL ?? "postgresql://forge:owner-dev-only@127.0.0.1:55520/forge", reset = false) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  if (reset) await c.query("TRUNCATE comments, simulation_runs, scene_ops, scenario_branches, telemetry_points, telemetry_bindings, connectors, assets, twin_projects, api_tokens, idempotency_keys, audit_log, client_telemetry, organizations CASCADE");
  if ((await c.query("SELECT count(*)::int n FROM organizations")).rows[0].n > 0 && !reset) { await c.query("ROLLBACK"); await c.end(); return; }
  for (const o of ORGS) await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,$4)", [o.id, o.slug, o.name, o.plan]);
  for (const t of TOKENS) await c.query("INSERT INTO api_tokens (token_sha256, organization_id, role, label) VALUES ($1,$2,$3,$4)", [sha256(t.token), ORGS.find((o) => o.slug === t.org)!.id, t.role, t.token]);
  await c.query("COMMIT");
  await c.end();
  console.log(JSON.stringify({ msg: "seeded", orgs: ORGS.length, tokens: TOKENS.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await seed(undefined, process.argv.includes("--reset"));
