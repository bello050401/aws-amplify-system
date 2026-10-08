import { createHash } from "node:crypto";
import { readGeneralPrivateCreate } from "./generalPrivateCreateJob.mjs";
import { fetchCurrentGeneralPrivateCreateSnapshot } from
  "./generalPrivateCreateImages.mjs";
import { captureGeneralPrivateInitialScanReadOnly } from
  "./generalPrivateCreateInitialScan.mjs";
import { preflightGeneralPrivateCreateRemote } from
  "./generalPrivateCreateRemotePreflight.mjs";
import { runB005396PrivateDraftPcFlow } from
  "./generalPrivateDraftPcFlow.mjs";
import { openDraftMetadataReadSession } from "./session.mjs";
import { isExplicitDraftReadQueryRequest } from
  "./draftReadMetadataObserver.mjs";

const INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const SHOP = "evkhihBFFNn5hukMS9s36H";
const SHA = /^[a-f0-9]{64}$/;
const fixed = diagnostic => ({ status: "BLOCKED", diagnostic,
  listingConfirmed: false, allowPublic: false });

/** A reviewed value set is exact, target-bound, and checked against live BELLO bytes. */
export async function reviewB005396PrivateDraft({ inventoryId, pack }, {
  evidence = null, origin, belloProfileDir, playwrightModulePath,
  fetchSnapshot = fetchCurrentGeneralPrivateCreateSnapshot,
} = {}) {
  if (inventoryId !== INVENTORY || pack?.shopId !== SHOP ||
      !evidence || Object.keys(evidence).sort().join() !== [
        "draftId", "imageSha256", "inventoryId", "managementCode",
        "priceYen", "privateOnly", "quantity", "shippingReviewRequired",
        "shopId", "title"].sort().join() ||
      evidence.shopId !== SHOP || evidence.inventoryId !== INVENTORY ||
      evidence.draftId !== pack.draftId ||
      evidence.managementCode !== pack.managementCode ||
      evidence.title !== pack.title || evidence.priceYen !== 99_999 ||
      evidence.quantity !== 1 || evidence.privateOnly !== true ||
      evidence.shippingReviewRequired !== true ||
      !SHA.test(evidence.imageSha256 ?? "") ||
      pack.priceYen !== evidence.priceYen ||
      pack.quantity !== evidence.quantity || pack.imageRefs?.length !== 1)
    return false;
  try {
    const snapshot = await fetchSnapshot({ origin, belloProfileDir,
      playwrightModulePath, pack });
    const file = snapshot?.files?.[0];
    return snapshot.files.length === 1 &&
      snapshot.sourcePriceYen === 50_000 &&
      snapshot.sourceShippingMethod === "KAZAI" &&
      file.storageKey === pack.imageRefs[0].storageKey &&
      Buffer.isBuffer(file.buffer) &&
      createHash("sha256").update(file.buffer).digest("hex") ===
        evidence.imageSha256 && file.sha256 === evidence.imageSha256;
  } catch { return false; }
}

/** The dedicated Chrome profile is routed to GET/HEAD and explicit named queries. */
export function bindB005396InitialScan({ root, shopsProfileDir,
  playwrightModulePath }, {
  openSession = openDraftMetadataReadSession,
  scan = captureGeneralPrivateInitialScanReadOnly,
} = {}) {
  return async ({ shopId, managementCode, title }) => {
    if (shopId !== SHOP || typeof scan !== "function")
      throw Error("SCAN_TARGET_UNVERIFIED");
    let blocked = false;
    const requestGuard = async route => {
      try {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
            isExplicitDraftReadQueryRequest(request)) await route.continue();
        else { blocked = true; await route.abort(); }
      } catch {
        blocked = true;
        try { await route.abort(); } catch { /* Browser close also blocks it. */ }
      }
    };
    const session = await openSession({ root, profileDir: shopsProfileDir,
      playwrightModulePath, shopId, requestGuard,
      onWebSocketBlocked: () => { blocked = true; } });
    try {
      await session.context.setOffline(false);
      const result = await scan({ page: session.page, shopId,
        managementCode, title, expectedDraftRowCount: 12 });
      if (blocked) throw Error("SCAN_NETWORK_GUARD_BLOCKED");
      return result;
    } finally { await session.context.close().catch(() => {}); }
  };
}

/** Default dry mode can only review/read. Live mode remains behind explicit review. */
export async function runB005396ReviewedDraft(args, {
  evidence = null, mode = "DRY_READ_ONLY", allowLiveAfterReview = false,
  fetchSnapshot = fetchCurrentGeneralPrivateCreateSnapshot,
  captureInitialScan = null,
  flow = runB005396PrivateDraftPcFlow,
  remotePreflight = preflightGeneralPrivateCreateRemote,
} = {}) {
  if (args?.inventoryId !== INVENTORY) return fixed("TARGET_UNVERIFIED");
  const capture = captureInitialScan ?? bindB005396InitialScan(args);
  let pack;
  try { ({ pack } = await readGeneralPrivateCreate(args.root, INVENTORY)); }
  catch { return fixed("PACK_UNVERIFIED"); }
  const reviewGate = ({ inventoryId, pack: reviewedPack }) =>
    reviewB005396PrivateDraft({ inventoryId, pack: reviewedPack }, {
      evidence, origin: args.origin, belloProfileDir: args.belloProfileDir,
      playwrightModulePath: args.playwrightModulePath, fetchSnapshot });
  if (mode === "DRY_READ_ONLY") {
    const reviewed = await reviewGate({ inventoryId: INVENTORY, pack });
    let remote;
    try { remote = await remotePreflight({ root: args.root,
      inventoryId: INVENTORY, captureReadOnlyScan: capture }); }
    catch { remote = { status: "REMOTE_SCAN_UNAVAILABLE" }; }
    return { ...fixed(reviewed ? "DRY_READ_ONLY" : "REVIEW_HOLD"),
      reviewMatched: reviewed, remoteStatus: remote.status };
  }
  if (mode !== "LIVE" || allowLiveAfterReview !== true)
    return fixed("LIVE_REVIEW_HOLD");
  if (!await reviewGate({ inventoryId: INVENTORY, pack }))
    return fixed("REVIEW_HOLD");
  return flow(args, { reviewGate, captureInitialScan: capture });
}
