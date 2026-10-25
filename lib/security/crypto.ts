import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { SecurityError } from "./types";
export const randomId = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
export function publicKey(value: unknown): JsonWebKey {
  const k = value as JsonWebKey;
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || k.d || !k.x || !k.y ||
    !/^[A-Za-z0-9_-]{43}$/.test(k.x) || !/^[A-Za-z0-9_-]{43}$/.test(k.y)) throw new SecurityError("INVALID_DEVICE_KEY", 400);
  const clean = { kty: k.kty, crv: k.crv, x: k.x, y: k.y };
  try { createPublicKey({ key: clean, format: "jwk" }); } catch { throw new SecurityError("INVALID_DEVICE_KEY", 400); }
  return clean;
}
export function keyId(k: JsonWebKey) { return hash(JSON.stringify(publicKey(k))); }
/** Fixed route + origin + exact request digest. A proof cannot authorize another action. */
export function proofMessage(origin: string, nonce: string, digest: string) {
  return ["BELLO-DEVICE-PROOF-v1", origin, "POST", "/api/security/action", nonce, digest].join("\n");
}
export function verifyProof(k: JsonWebKey, message: string, signature: string) {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try { return verify("sha256", Buffer.from(message), { key: createPublicKey({ key: { ...publicKey(k) }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")); }
  catch { return false; }
}
export function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}
