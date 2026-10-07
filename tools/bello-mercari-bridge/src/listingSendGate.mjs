import { mkdir, open, readFile, readdir, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LISTING_SEND_GAP_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seen = new Map();
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

function paths(root, shopId) {
  if (typeof root !== "string" || !isAbsolute(root) || !ID.test(shopId))
    throw Error("Invalid listing-send gate root or shop");
  const dir = join(root, "listing-send-attempts");
  return { dir, legacyLock: join(dir, `${shopId}.lock`),
    gateLock: join(dir, `${shopId}.listing-gate.lock`) };
}

async function legacyLockIsHeld(path) {
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    if (["EBUSY", "EACCES", "EPERM"].includes(error?.code)) return true;
    throw error;
  }
  await handle.close();
  return false;
}

async function gateLockExists(path) {
  try { return (await stat(path)).isDirectory(); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

/** A newly seen marker starts a full monotonic 30-second wait after restart. */
async function markerWindow(root, shopId, monoNow) {
  const { dir } = paths(root, shopId);
  if (!Number.isFinite(monoNow)) throw Error("Invalid monotonic time");
  let names;
  try { names = await readdir(dir); }
  catch (error) {
    if (error?.code === "ENOENT") names = [];
    else throw error;
  }
  const markers = [];
  for (const name of names) {
    if (!name.startsWith(`${shopId}-`) || !name.endsWith(".json")) continue;
    const marker = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (marker?.schemaVersion !== 1 || marker.shopId !== shopId ||
        marker.minimumGapSeconds !== 30 ||
        !Number.isFinite(Date.parse(marker.potentialSendAt)))
      throw Error("Listing-send marker requires manual review");
    markers.push(`${name}:${marker.potentialSendAt}`);
  }
  markers.sort();
  const key = `${root}\0${shopId}`;
  const signature = markers.join("\0");
  let state = seen.get(key);
  if (markers.length === 0) {
    if (state) throw Error("Listing-send marker disappeared during this process");
    return { remainingMs: 0, signature, key };
  }
  if (!state || state.signature !== signature || monoNow < state.lastAt) {
    state = { signature, lastAt: monoNow };
    seen.set(key, state);
  }
  return { remainingMs: Math.max(0, state.lastAt + LISTING_SEND_GAP_MS - monoNow),
    signature, key };
}

/** Read-only display. An active or abandoned lock reports unavailable. */
export async function readShopListingWindow(root, shopId, monoNow = monotonicMs()) {
  const { legacyLock, gateLock } = paths(root, shopId);
  if (await legacyLockIsHeld(legacyLock) || await gateLockExists(gateLock))
    return { remainingSeconds: null, nextAllowedAt: null };
  const window = await markerWindow(root, shopId, monoNow);
  return { remainingSeconds: Math.ceil(window.remainingMs / 1000),
    nextAllowedAt: window.remainingMs > 0 ?
      new Date(Date.now() + window.remainingMs).toISOString() : null };
}

/** Hold shop exclusion across the UI click and verified or UNKNOWN result. */
export async function withShopListingSend(root, { shopId, inventoryId,
  operation, attemptId }, action, { monoNow = monotonicMs,
    sleep = sleepMs } = {}) {
  if (typeof inventoryId !== "string" || !UUID.test(inventoryId) ||
      !["CREATE", "RELIST"].includes(operation) ||
      typeof attemptId !== "string" || !UUID.test(attemptId) ||
      typeof action !== "function")
    throw Error("Invalid potential listing send");
  const { dir, legacyLock, gateLock } = paths(root, shopId);
  await mkdir(dir, { recursive: true });
  await mkdir(gateLock); // An abandoned lock requires manual review; never auto-remove it.
  let markerWritten = false;
  try {
    if (await legacyLockIsHeld(legacyLock)) throw Error("Legacy listing send is active");
    let window = await markerWindow(root, shopId, monoNow());
    while (window.remainingMs > 0) {
      await sleep(Math.min(window.remainingMs, 1000));
      window = await markerWindow(root, shopId, monoNow());
    }
    if (await legacyLockIsHeld(legacyLock)) throw Error("Legacy listing send is active");
    const marker = { schemaVersion: 1, shopId, inventoryId, operation,
      attemptId, potentialSendAt: new Date().toISOString(),
      minimumGapSeconds: 30, status: "POTENTIAL_SEND_ONCE" };
    const handle = await open(join(dir, `${shopId}-${attemptId}.json`), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(marker) + "\n", "utf8");
      await handle.sync(); markerWritten = true; }
    finally { await handle.close(); }
    return await action(marker);
  } finally {
    if (markerWritten) {
      const window = await markerWindow(root, shopId, monoNow());
      seen.set(window.key, { signature: window.signature, lastAt: monoNow() });
    }
    await rmdir(gateLock);
  }
}
