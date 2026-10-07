import { createHash } from "node:crypto";
import { exactGeneralPrivateCreatePack, readGeneralPrivateCreate,
  readGeneralPrivateCreateClaim, claimGeneralPrivateCreateOnce,
  writeGeneralPrivateCreateResultOnce } from "./generalPrivateCreateJob.mjs";
import { preflightGeneralPrivateCreateRemote } from
  "./generalPrivateCreateRemotePreflight.mjs";
import { fetchCurrentGeneralPrivateCreateImages } from
  "./generalPrivateCreateImages.mjs";
import { fillGeneralPrivateCreateFormOnce, GeneralFormMismatch } from
  "./generalPrivateCreateForm.mjs";
import { openGeneralPrivateCreateFormSession } from "./session.mjs";

const SHOPS = "https://mercari-shops.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The only allowed create URL is the fixed shop path and at most one draft ID. */
export function inspectGeneralPrivateCreateUrl(raw, shopId) {
  try {
    const url = new URL(raw);
    if (url.origin !== SHOPS || url.username || url.password || url.hash ||
        url.pathname !== `/seller/shops/${shopId}/products/create`)
      return { valid: false, draftId: null };
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return { valid: true, draftId: null };
    const draftId = url.searchParams.get("productDraftId");
    return keys.length === 1 && keys[0] === "productDraftId" &&
      ID.test(draftId ?? "") ? { valid: true, draftId } :
      { valid: false, draftId: null };
  } catch { return { valid: false, draftId: null }; }
}

function exactImageFiles(pack, files) {
  return Array.isArray(files) && files.length === pack.imageRefs.length &&
    files.every((file, index) => file?.storageKey ===
      pack.imageRefs[index].storageKey && file.index === index &&
      Buffer.isBuffer(file.buffer) && file.buffer.length > 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256 ?? "") &&
      createHash("sha256").update(file.buffer).digest("hex") === file.sha256 &&
      ["image/jpeg", "image/png"].includes(file.mimeType) &&
      typeof file.filename === "string" &&
      /^[^/\\]+\.(?:jpe?g|png)$/i.test(file.filename));
}

/**
 * One form-fill attempt only. It never opens a save/publish dialog or clicks a
 * final action. The create screen and image selection can autosave, so the
 * permanent UNKNOWN claim is written before launching the Shops browser.
 */
export async function fillGeneralPrivateCreateFormOnly({ root, inventoryId,
  origin, belloProfileDir, shopsProfileDir, playwrightModulePath,
  captureReadOnlyScan = null }, {
    remotePreflight = preflightGeneralPrivateCreateRemote,
    fetchImages = fetchCurrentGeneralPrivateCreateImages,
    claimOnce = claimGeneralPrivateCreateOnce,
    openSession = openGeneralPrivateCreateFormSession,
    fillForm = fillGeneralPrivateCreateFormOnce,
    recordResult = writeGeneralPrivateCreateResultOnce,
  } = {}) {
  const record = await readGeneralPrivateCreate(root, inventoryId);
  const pack = exactGeneralPrivateCreatePack(record.pack);
  if (!pack || pack.inventoryId !== inventoryId || pack.brandId !== null)
    return { status: "BLOCKED", diagnostic: "PACK_OR_BRAND_UNVERIFIED" };
  if (await readGeneralPrivateCreateClaim(root, inventoryId))
    return { status: "BLOCKED", diagnostic: "LOCAL_CLAIM_UNKNOWN_NO_RETRY" };
  const remote = await remotePreflight({ root, inventoryId,
    captureReadOnlyScan });
  if (remote?.status !== "NO_MATCH_IN_OBSERVED_UI" ||
      remote.allowFinalCreate !== false)
    return { status: "BLOCKED", diagnostic: remote?.status ??
      "REMOTE_SCAN_UNVERIFIED" };
  let files;
  try {
    files = await fetchImages({ origin, belloProfileDir,
      playwrightModulePath, pack });
  } catch {
    return { status: "BLOCKED", diagnostic: "BELLO_SOURCE_REREAD_UNAVAILABLE" };
  }
  if (!exactImageFiles(pack, files))
    return { status: "BLOCKED", diagnostic: "BELLO_IMAGE_PROOF_UNVERIFIED" };

  // From this point a remote auto-draft is possible, even without a save click.
  const claim = await claimOnce(root, inventoryId);
  let session = null;
  let diagnostic = "BROWSER_UNAVAILABLE";
  let observedDraftId = null;
  const seenDraftIds = new Set();
  const checkpoint = () => {
    const current = inspectGeneralPrivateCreateUrl(session.page.url(), pack.shopId);
    if (!current.valid) throw Error("CREATE_URL_UNVERIFIED");
    if (current.draftId) seenDraftIds.add(current.draftId);
    if (seenDraftIds.size > 1) throw Error("MULTIPLE_DRAFT_IDS_OBSERVED");
    observedDraftId = current.draftId;
  };
  try {
    session = await openSession({ root, profileDir: shopsProfileDir,
      playwrightModulePath, shopId: pack.shopId, claim });
    diagnostic = "EXACT_SHOP_LIST_UNAVAILABLE";
    const listUrl = `${SHOPS}/seller/shops/${pack.shopId}/products?tab=on_sale&visibility=unopened`;
    if (session.state !== "LIST_OPEN" || session.page.url() !== listUrl)
      throw Error("EXACT_SHOP_LIST_UNAVAILABLE");
    diagnostic = "CREATE_LINK_UNVERIFIED";
    const link = session.page.getByRole("link", { name: "商品登録", exact: true });
    if (await link.count() !== 1 || !await link.isEnabled())
      throw Error("CREATE_LINK_UNVERIFIED");
    const href = await link.getAttribute("href");
    if (!href || new URL(href, listUrl).href !==
        `${SHOPS}/seller/shops/${pack.shopId}/products/create` ||
        session.page.url() !== listUrl)
      throw Error("CREATE_LINK_UNVERIFIED");
    diagnostic = "CREATE_PAGE_UNCERTAIN";
    await link.click({ timeout: 12000 });
    checkpoint();
    diagnostic = "FORM_FIELDS_UNCERTAIN";
    const assets = await fillForm(session.page, pack, files, {
      onStage: code => { checkpoint(); diagnostic = code; },
    });
    checkpoint();
    if (!Array.isArray(assets) || assets.length !== pack.imageRefs.length)
      throw Error("IMAGE_ASSET_UNVERIFIED");
    diagnostic = "FORM_READY_NO_SAVE";
  } catch (error) {
    if (error instanceof GeneralFormMismatch ||
        /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? ""))
      diagnostic = error.code ?? error.message;
  }
  await recordResult(root, inventoryId, { attemptId: claim.attemptId,
    outcome: "UNKNOWN", listingConfirmed: false, observedRemoteId: null,
    observedDraftId, reasonCode: diagnostic });
  return { status: diagnostic === "FORM_READY_NO_SAVE" ?
    "FORM_READY_NO_SAVE" : "UNKNOWN", diagnostic,
    listingConfirmed: false, allowSave: false,
    observedDraftId, retainedSession: session };
}
