import { createHmac, timingSafeEqual } from "node:crypto";
import { hash } from "./crypto";
import { SecurityError } from "./types";

export const GRANT_HEADER = "x-bello-server-grant";
export type ServerGrant = { at: number; binding: string; sub: string; username: string; groups: string[]; deviceId: string };
/** This header is internal to middleware -> SSR. Never accept an unsigned context. */
export function issueServerGrant(grant: ServerGrant, key: string) {
  // Next's development RSC diagnostics can serialize internal request headers.
  // Keep ALL Cognito tokens out of this context, in development and production.
  const safe={at:grant.at,binding:grant.binding,sub:grant.sub,username:grant.username,groups:grant.groups,deviceId:grant.deviceId};
  const payload = Buffer.from(JSON.stringify(safe)).toString("base64url");
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}
export function readServerGrant(header: string | null, token: string, key: string, now = Math.floor(Date.now() / 1000)): ServerGrant {
  if (!header || header.length > 32768) throw new SecurityError("DEVICE_PROOF_REQUIRED");
  const parts = header.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new SecurityError("DEVICE_PROOF_REQUIRED");
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[1], "base64url"))) throw new SecurityError("DEVICE_PROOF_REQUIRED");
  let grant: ServerGrant;
  try { grant = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { throw new SecurityError("DEVICE_PROOF_REQUIRED"); }
  if (!Number.isSafeInteger(grant.at) || now < grant.at - 5 || now - grant.at > 60 || grant.binding !== hash(token) ||
    !grant.sub || !Array.isArray(grant.groups)) throw new SecurityError("DEVICE_PROOF_REQUIRED");
  return grant;
}
