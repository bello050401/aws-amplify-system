import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE = /^[^\x00-\x1f\x7f]{1,130}$/;
const PROTECTED_PUBLIC_IDS = new Set(["2JWp7EJx6aqKfn6dTXc5Q9",
  "2JToDtSgGowzUwnwe9hgHU"]);
const PRIVATE_ONLY_INVENTORIES = new Set([
  "dd273c1e-9b2a-4013-acc6-c445a481fab8",
  "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
]);
const RESERVED_TEST_CODES = new Set(["B005659", "TEST_B005659_E51E4F6B7B86DD150546",
  "B005413", "TEST_B005413_B63EF3F86211FFE0F890D81E"]);

/** Pure preflight only. A READY result cannot click, save, or update BELLO. */
export function planVisibilityTransition({ action, target, readback,
  listing = null, stopProof = null } = {}) {
  if (!["STOP", "RELIST"].includes(action) ||
      target?.shopId !== PRIVATE_CREATE_SHOP_ID ||
      typeof target.inventoryId !== "string" || !UUID.test(target.inventoryId) ||
      PRIVATE_ONLY_INVENTORIES.has(target.inventoryId.toLowerCase()) ||
      typeof target.remoteId !== "string" || !ID.test(target.remoteId) ||
      PROTECTED_PUBLIC_IDS.has(target.remoteId) ||
      typeof target.skuCode !== "string" ||
      RESERVED_TEST_CODES.has(target.skuCode.toUpperCase()) ||
      target.visibilityPolicy !== "PUBLIC_ALLOWED" ||
      typeof target.title !== "string" || !TITLE.test(target.title) ||
      !target.title.trim() ||
      readback?.kind !== "OBSERVED" || readback.shopId !== target.shopId ||
      readback.remoteId !== target.remoteId || readback.title !== target.title)
    return { kind: "BLOCKED" };

  if (action === "STOP") {
    if (listing?.externalListingId !== target.remoteId ||
        listing.status !== "ACTIVE" || readback.visibility !== "PUBLIC")
      return { kind: "BLOCKED" };
    return { kind: "READY", action, remoteId: target.remoteId,
      expectedBefore: "PUBLIC", expectedAfter: "PRIVATE",
      saveLabel: "非公開で保存する" };
  }

  // A merely private product may be an unpublished draft. Relisting requires
  // an independently verified stop of this same product, plus public permission.
  if (target.visibilityPolicy !== "PUBLIC_ALLOWED" ||
      readback.visibility !== "PRIVATE" ||
      stopProof?.kind !== "STOP_VERIFIED" ||
      stopProof.shopId !== target.shopId ||
      stopProof.remoteId !== target.remoteId ||
      stopProof.title !== target.title ||
      stopProof.resultingVisibility !== "PRIVATE")
    return { kind: "BLOCKED" };
  return { kind: "READY", action, remoteId: target.remoteId,
    expectedBefore: "PRIVATE", expectedAfter: "PUBLIC",
    saveLabel: "公開する" };
}
