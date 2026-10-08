import { createHash } from "node:crypto";
import { exactGeneralPrivateCreatePack, readGeneralPrivateCreate } from
  "./generalPrivateCreateJob.mjs";
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
const CATEGORY = "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ";
const SHIPPING = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fixed = diagnostic => ({ status: "BLOCKED", diagnostic,
  listingConfirmed: false, allowPublic: false });

function fixedPack(pack) {
  const exact = exactGeneralPrivateCreatePack(pack);
  return exact?.shopId === SHOP && exact.inventoryId === INVENTORY &&
    exact.priceYen === 99_999 && exact.quantity === 1 &&
    exact.categoryPath === CATEGORY && exact.condition === "NO_NOTABLE_DAMAGE" &&
    exact.brandId === null && exact.brandName === null &&
    exact.imageRefs.length === 1 && same(exact.shipping, SHIPPING) ? exact : null;
}

/** Reads the current BELLO bytes and reports only a hash and pinned pack facts. */
export async function readB005396ImageByteProof(args, {
  fetchSnapshot = fetchCurrentGeneralPrivateCreateSnapshot,
} = {}) {
  if (args?.inventoryId !== INVENTORY) return fixed("TARGET_UNVERIFIED");
  let pack, fingerprint;
  try { ({ pack, fingerprint } = await readGeneralPrivateCreate(
    args.root, INVENTORY)); }
  catch { return fixed("PACK_UNVERIFIED"); }
  if (!fixedPack(pack)) return fixed("REVIEWED_VALUES_CHANGED");
  let snapshot;
  try { snapshot = await fetchSnapshot({ origin: args.origin,
    belloProfileDir: args.belloProfileDir,
    playwrightModulePath: args.playwrightModulePath, pack }); }
  catch (error) { return fixed(error?.message === "BELLO_ADMIN_LOGIN_REQUIRED" ?
    "BELLO_ADMIN_LOGIN_REQUIRED" : "BELLO_SOURCE_REREAD_UNAVAILABLE"); }
  const file = snapshot?.files?.[0];
  if (snapshot?.files?.length !== 1 ||
      snapshot.sourcePriceYen !== 50_000 ||
      snapshot.sourceShippingMethod !== "KAZAI" ||
      file?.storageKey !== pack.imageRefs[0].storageKey ||
      !Buffer.isBuffer(file?.buffer) ||
      !SHA.test(file?.sha256 ?? "") ||
      createHash("sha256").update(file.buffer).digest("hex") !== file.sha256)
    return fixed("BELLO_IMAGE_BYTES_UNVERIFIED");
  return { status: "IMAGE_BYTES_READ_ONLY_VERIFIED",
    listingConfirmed: false, allowPublic: false,
    proof: { schemaVersion: 1, kind: "B005396_IMAGE_BYTES_READ_ONLY",
      shopId: SHOP, inventoryId: INVENTORY, draftId: pack.draftId,
      packFingerprint: fingerprint, managementCode: pack.managementCode,
      title: pack.title, description: pack.description,
      categoryPath: pack.categoryPath, shipping: pack.shipping,
      priceYen: pack.priceYen, quantity: pack.quantity,
      imageSha256: file.sha256, sourcePriceYen: snapshot.sourcePriceYen,
      sourceShippingMethod: snapshot.sourceShippingMethod,
      observedAt: new Date().toISOString() } };
}

/** A reviewed value set is exact, target-bound, and checked against live BELLO bytes. */
export async function reviewB005396PrivateDraft({ inventoryId, pack }, {
  evidence = null, origin, belloProfileDir, playwrightModulePath,
  fetchSnapshot = fetchCurrentGeneralPrivateCreateSnapshot,
} = {}) {
  const exact = fixedPack(pack);
  if (inventoryId !== INVENTORY || !exact ||
      !evidence || Object.keys(evidence).sort().join() !== [
        "categoryPath", "description", "draftId", "imageSha256",
        "inventoryId", "managementCode", "packFingerprint", "priceYen",
        "privateOnly", "quantity", "shipping", "shippingReviewRequired",
        "shopId", "title"].sort().join() ||
      evidence.shopId !== SHOP || evidence.inventoryId !== INVENTORY ||
      evidence.draftId !== exact.draftId ||
      evidence.packFingerprint !== createHash("sha256")
        .update(JSON.stringify(exact)).digest("hex") ||
      evidence.managementCode !== exact.managementCode ||
      evidence.title !== exact.title ||
      evidence.description !== exact.description ||
      evidence.categoryPath !== exact.categoryPath ||
      !same(evidence.shipping, exact.shipping) ||
      evidence.priceYen !== 99_999 ||
      evidence.quantity !== 1 || evidence.privateOnly !== true ||
      evidence.shippingReviewRequired !== true ||
      !SHA.test(evidence.imageSha256 ?? "") ||
      exact.priceYen !== evidence.priceYen ||
      exact.quantity !== evidence.quantity)
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
