import { mkdir, open, readFile, readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LISTING_SEND_GAP_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paths(root, shopId) {
  if (typeof root !== "string" || !isAbsolute(root) || !ID.test(shopId))
    throw Error("Invalid listing-send gate root or shop");
  const dir = join(root, "listing-send-attempts");
  return { dir, lock: join(dir, `${shopId}.lock`) };
}

/** Existing potential-send markers count even when a later result was UNKNOWN. */
export async function readShopListingWindow(root, shopId, nowMs = Date.now()) {
  const { dir } = paths(root, shopId);
  if (!Number.isFinite(nowMs)) throw Error("Invalid listing-send gate time");
  let names;
  try { names = await readdir(dir); }
  catch (error) {
    if (error?.code === "ENOENT") return { remainingSeconds: 0, nextAllowedAt: null };
    throw error;
  }
  let latest = null;
  for (const name of names) {
    if (!name.startsWith(`${shopId}-`) || !name.endsWith(".json")) continue;
    const marker = JSON.parse(await readFile(join(dir, name), "utf8"));
    const when = Date.parse(marker?.potentialSendAt);
    if (marker?.schemaVersion !== 1 || marker.shopId !== shopId ||
        marker.minimumGapSeconds !== 30 || !Number.isFinite(when))
      throw Error("Listing-send marker requires manual review");
    latest = latest === null ? when : Math.max(latest, when);
  }
  const next = latest === null ? null : latest + LISTING_SEND_GAP_MS;
  return { remainingSeconds: next === null ? 0 :
    Math.max(0, Math.ceil((next - nowMs) / 1000)),
    nextAllowedAt: next === null ? null : new Date(next).toISOString() };
}

/** Persist a possible send before the final Shops save click; crash leaves the lock closed. */
export async function reserveShopListingSend(root, { shopId, inventoryId,
  operation, attemptId }, { now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof inventoryId !== "string" || !UUID.test(inventoryId) ||
      !["CREATE", "RELIST"].includes(operation) ||
      typeof attemptId !== "string" || !UUID.test(attemptId))
    throw Error("Invalid potential listing send");
  const { dir, lock } = paths(root, shopId);
  await mkdir(dir, { recursive: true });
  await mkdir(lock); // An abandoned lock is never removed automatically.
  try {
    const window = await readShopListingWindow(root, shopId, now());
    if (window.nextAllowedAt) {
      const waitMs = Math.max(0, Date.parse(window.nextAllowedAt) - now());
      if (waitMs > 0) await sleep(waitMs);
      if (now() < Date.parse(window.nextAllowedAt))
        throw Error("Listing-send clock did not reach the next allowed time");
    }
    const marker = { schemaVersion: 1, shopId, inventoryId, operation,
      attemptId, potentialSendAt: new Date(now()).toISOString(),
      minimumGapSeconds: 30, status: "POTENTIAL_SEND_ONCE" };
    const handle = await open(join(dir, `${shopId}-${attemptId}.json`), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(marker) + "\n", "utf8");
      await handle.sync(); }
    finally { await handle.close(); }
    return marker;
  } finally { await rmdir(lock); }
}
