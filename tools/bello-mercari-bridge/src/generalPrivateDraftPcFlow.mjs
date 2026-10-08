import { readGeneralPrivateCreate } from "./generalPrivateCreateJob.mjs";
import { fillGeneralPrivateCreateFormOnly } from
  "./generalPrivateCreateFormOnly.mjs";
import { bindB005396PrivateDraftDuplicateReader } from
  "./generalPrivateDraftDuplicateReader.mjs";
import { saveB005396PrivateDraftOnce } from
  "./generalPrivateDraftSaveOnce.mjs";

const INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const CATEGORY = "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ";
const blocked = diagnostic => ({ status: "BLOCKED", diagnostic,
  listingConfirmed: false, allowPublic: false });
const unknown = diagnostic => ({ status: "UNKNOWN", diagnostic,
  listingConfirmed: false, allowPublic: false, retryAllowed: false });

/**
 * PC flow assembly for the reviewed B005396 pack. The default review gate is
 * closed, so installing this module cannot start a Shops form or save.
 */
export async function runB005396PrivateDraftPcFlow({ root, inventoryId,
  origin, belloProfileDir, shopsProfileDir, playwrightModulePath }, {
    reviewGate = () => false,
    captureInitialScan = null,
    fillForm = fillGeneralPrivateCreateFormOnly,
    bindDuplicateReader = bindB005396PrivateDraftDuplicateReader,
    saveDraft = saveB005396PrivateDraftOnce,
  } = {}) {
  if (inventoryId !== INVENTORY) return blocked("TARGET_UNVERIFIED");
  let pack;
  try { ({ pack } = await readGeneralPrivateCreate(root, inventoryId)); }
  catch { return blocked("PACK_UNVERIFIED"); }
  if (pack.priceYen !== 99_999 || pack.quantity !== 1 ||
      pack.categoryPath !== CATEGORY || pack.condition !== "NO_NOTABLE_DAMAGE" ||
      pack.brandId !== null || pack.brandName !== null ||
      pack.imageRefs.length !== 1 ||
      pack.shipping.method !== "METHOD_TYPE_UNDECIDED" ||
      pack.shipping.payer !== "PAYER_TYPE_SELLER" ||
      pack.shipping.origin !== "jp11" ||
      pack.shipping.duration !== "DURATION_TYPE_FOUR_TO_SEVEN_DAYS")
    return blocked("REVIEWED_VALUES_CHANGED");
  if (typeof reviewGate !== "function") return blocked("REVIEW_HOLD");
  let reviewed;
  try { reviewed = await reviewGate({ inventoryId, pack }); }
  catch { return blocked("REVIEW_HOLD"); }
  if (reviewed !== true) return blocked("REVIEW_HOLD");
  if (typeof captureInitialScan !== "function" ||
      typeof fillForm !== "function" ||
      typeof bindDuplicateReader !== "function" ||
      typeof saveDraft !== "function")
    return blocked("READERS_UNAVAILABLE");

  let form;
  try { form = await fillForm({ root, inventoryId, origin,
    belloProfileDir, shopsProfileDir, playwrightModulePath,
    captureReadOnlyScan: captureInitialScan }); }
  catch { return unknown("FORM_RESULT_UNKNOWN_NO_RETRY"); }
  if (form?.status !== "FORM_READY_NO_SAVE" ||
      form.allowSave !== false || form.listingConfirmed !== false ||
      !form.retainedSession?.context)
    return { ...unknown("FORM_RESULT_UNKNOWN_NO_RETRY"),
      retainedSession: form?.retainedSession ?? null };

  let captureDuplicateProof;
  try { captureDuplicateProof = bindDuplicateReader(
    form.retainedSession.context); }
  catch { return { ...unknown("DUPLICATE_READER_UNAVAILABLE"),
    retainedSession: form.retainedSession }; }
  if (typeof captureDuplicateProof !== "function")
    return { ...unknown("DUPLICATE_READER_UNAVAILABLE"),
      retainedSession: form.retainedSession };
  try { return await saveDraft({ root, inventoryId, form, origin,
    belloProfileDir, playwrightModulePath }, { captureDuplicateProof }); }
  catch { return { ...unknown("DRAFT_SAVE_UNKNOWN_NO_RETRY"),
    retainedSession: form.retainedSession }; }
}
