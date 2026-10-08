import "server-only";

import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";

/** Opaque material from a future, human-operated browser login adapter. */
export type WebHttpSessionRecord = {
  schemaVersion: 1;
  shopId: string;
  ownerSub: string;
  sessionId: string;
  authenticatedAt: string;
  expiresAt: string | null;
  opaqueMaterial: string;
};
export type WebHttpSessionStore = {
  read: () => Promise<WebHttpSessionRecord | null>;
  write: (record: WebHttpSessionRecord) => Promise<void>;
};
export type WebHttpSessionProbe = (opaqueMaterial: string) =>
  Promise<"VALID" | "EXPIRED" | "UNKNOWN">;
export type WebHttpSessionDecision = {
  status: "READY_FOR_READONLY_PREFLIGHT" | "AUTH_REQUIRED" |
    "AUTH_UNVERIFIED" | "STORAGE_UNAVAILABLE" | "INVALID_INPUT";
  allowHttpWrite: false;
  reauthenticationRequired: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decision = (status: WebHttpSessionDecision["status"]):
  WebHttpSessionDecision => ({ status, allowHttpWrite: false,
    reauthenticationRequired: status === "AUTH_REQUIRED" });
const validClock = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validIso = (value: string) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  validClock(Date.parse(value));
const validOwner = (value: string) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validRecord(row: WebHttpSessionRecord): boolean {
  return row?.schemaVersion === 1 && row.shopId === WEB_HTTP_SHOP_ID &&
    validOwner(row.ownerSub) && UUID.test(row.sessionId) &&
    validIso(row.authenticatedAt) &&
    (row.expiresAt === null || validIso(row.expiresAt) &&
      Date.parse(row.expiresAt) > Date.parse(row.authenticatedAt)) &&
    typeof row.opaqueMaterial === "string" &&
    Buffer.byteLength(row.opaqueMaterial, "utf8") > 0 &&
    Buffer.byteLength(row.opaqueMaterial, "utf8") <= 48 * 1024;
}
async function checkProbe(probe: WebHttpSessionProbe, material: string) {
  try {
    const value = await probe(material);
    return value === "VALID" || value === "EXPIRED" ? value : "UNKNOWN";
  } catch { return "UNKNOWN"; }
}

/**
 * Only a future trusted capture adapter may call this. No login or token
 * extraction is implemented here. A fresh read must succeed before storage.
 */
export async function saveVerifiedWebHttpSession(input: {
  shopId: string; ownerSub: string; sessionId: string;
  authenticatedAt: string; opaqueMaterial: string;
  expiresAt: string | null;
}, store: WebHttpSessionStore, probe: WebHttpSessionProbe,
clock: () => number = Date.now): Promise<WebHttpSessionDecision> {
  const now = clock();
  if (!validClock(now) || !input || input.shopId !== WEB_HTTP_SHOP_ID ||
      !validOwner(input.ownerSub) || typeof input.opaqueMaterial !== "string" ||
      typeof probe !== "function")
    return decision("INVALID_INPUT");
  const row: WebHttpSessionRecord = {
    schemaVersion: 1, shopId: input.shopId, ownerSub: input.ownerSub,
    sessionId: input.sessionId, authenticatedAt: input.authenticatedAt,
    expiresAt: input.expiresAt, opaqueMaterial: input.opaqueMaterial,
  };
  if (!validRecord(row) ||
      Date.parse(row.authenticatedAt) > now ||
      row.expiresAt !== null && Date.parse(row.expiresAt) <= now)
    return decision("INVALID_INPUT");
  const proof = await checkProbe(probe, row.opaqueMaterial);
  if (proof !== "VALID")
    return decision(proof === "EXPIRED" ? "AUTH_REQUIRED" : "AUTH_UNVERIFIED");
  // A probe can be slow. Never store a session after its known expiry.
  const afterProbe = clock();
  if (!validClock(afterProbe) || row.expiresAt !== null &&
      Date.parse(row.expiresAt) <= afterProbe)
    return decision("AUTH_REQUIRED");
  try { await store.write(row); }
  catch { return decision("STORAGE_UNAVAILABLE"); }
  return decision("READY_FOR_READONLY_PREFLIGHT");
}

/** Every later operation must probe again; a saved session has no assumed lifetime. */
export async function checkWebHttpSession(shopId: string, ownerSub: string,
  store: WebHttpSessionStore, probe: WebHttpSessionProbe,
  clock: () => number = Date.now): Promise<WebHttpSessionDecision> {
  const now = clock();
  if (shopId !== WEB_HTTP_SHOP_ID || !validOwner(ownerSub) ||
      !validClock(now) || typeof probe !== "function")
    return decision("INVALID_INPUT");
  let row: WebHttpSessionRecord | null;
  try { row = await store.read(); }
  catch { return decision("STORAGE_UNAVAILABLE"); }
  if (!row || row.ownerSub !== ownerSub) return decision("AUTH_REQUIRED");
  if (!validRecord(row)) return decision("STORAGE_UNAVAILABLE");
  if (Date.parse(row.authenticatedAt) > now ||
      row.expiresAt !== null && Date.parse(row.expiresAt) <= now)
    return decision("AUTH_REQUIRED");
  const proof = await checkProbe(probe, row.opaqueMaterial);
  if (proof === "EXPIRED") return decision("AUTH_REQUIRED");
  if (proof !== "VALID") return decision("AUTH_UNVERIFIED");
  const afterProbe = clock();
  if (!validClock(afterProbe) || row.expiresAt !== null &&
      Date.parse(row.expiresAt) <= afterProbe)
    return decision("AUTH_REQUIRED");
  return decision("READY_FOR_READONLY_PREFLIGHT");
}
