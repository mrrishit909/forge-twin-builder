// Postgres access. The API connects as forge_app, which row-level security applies to; every tenant query runs inside a
// transaction that first sets app.tenant, so a missing WHERE clause still cannot read another tenant's rows.
import pg from "pg";
import { createHash } from "node:crypto";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://forge_app:app-dev-only@127.0.0.1:55520/forge", max: 10 });

export async function withTenant<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant', $1, true)", [tenant]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted at every level: Postgres jsonb does not keep key order, so hashes must not depend on it. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Append to the hash-chained audit log (inside the caller's tenant transaction). */
export async function audit(c: pg.PoolClient, tenant: string, actor: string, action: string, target: string | null, detail: unknown, traceId: string | null) {
  const prev = await c.query("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prevHash = prev.rows[0]?.hash ?? "genesis";
  const body = canonical({ tenant, actor, action, target, detail });
  await c.query("INSERT INTO audit_log (tenant_id, actor, action, target, detail, trace_id, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [tenant, actor, action, target, detail, traceId, prevHash, sha256(prevHash + body)]);
}
