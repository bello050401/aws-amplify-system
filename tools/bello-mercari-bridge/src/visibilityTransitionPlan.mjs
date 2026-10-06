import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE = /^[^\x00-\x1f\x7f]{1,130}$/;
const PROTECTED_PUBLIC_ID = "2JWp7EJx6aqKfn6dTXc5Q9";
const PRIVATE_ONLY_INVENTORY = "dd273c1e-9b2a-4013-acc6-c445a481fab8";

/** Pure preflight only. A READY result cannot click, save, or update BELLO. */
export function planVisibilityTransition({ action, target, readback,
  listing = null, stopProof = null } = {}) {
  if (!["STOP", "RELIST"].includes(action) ||
      target?.shopId !== PRIVATE_CREATE_SHOP_ID ||
      !UUID.test(target?.inventoryId ?? "") || !ID.test(target?.remoteId ?? "") ||
      target.remoteId === PROTECTED_PUBLIC_ID ||
      !TITLE.test(target?.title ?? "") || !target.title.trim() ||
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
  if (target.inventoryId === PRIVATE_ONLY_INVENTORY ||
      target.visibilityPolicy !== "PUBLIC_ALLOWED" ||
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
