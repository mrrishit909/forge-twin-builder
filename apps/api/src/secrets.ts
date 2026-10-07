// Connector credentials are encrypted with AES-256-GCM before they reach the database; the key comes from the environment
// (a secret manager in production) and never from the database or the browser.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = () => {
  const hex = process.env.FORGE_SECRET_KEY ?? "";
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  if (process.env.NODE_ENV === "production") throw new Error("FORGE_SECRET_KEY (64 hex chars) is required");
  return Buffer.alloc(32, 7); // ponytail: fixed dev key outside production; real deployments must set FORGE_SECRET_KEY
};
export function encrypt(obj: unknown): Buffer {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function decrypt<T>(buf: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}
