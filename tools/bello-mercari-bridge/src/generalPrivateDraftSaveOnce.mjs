import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { exactGeneralPrivateCreatePack, readGeneralPrivateCreate,
  readGeneralPrivateCreateClaim } from "./generalPrivateCreateJob.mjs";
import { fetchCurrentGeneralPrivateCreateSnapshot } from
  "./generalPrivateCreateImages.mjs";
import { diagnoseGeneralPrivateCreateForm } from
  "./generalPrivateCreateForm.mjs";
import { inspectGeneralPrivateCreateUrl } from
  "./generalPrivateCreateFormOnly.mjs";
import { withShopListingSend } from "./listingSendGate.mjs";

const INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const CATEGORY = "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const UNKNOWN_REASONS = new Set(["SOURCE_CHANGED", "REMOTE_DUPLICATE_UNVERIFIED",
  "FORM_CHANGED", "DRAFT_BUTTON_UNVERIFIED", "SEND_GATE_UNAVAILABLE",
  "DRAFT_SAVE_CLICK_UNCERTAIN", "DRAFT_SAVE_READBACK_UNVERIFIED"]);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fixed = (status, diagnostic) => ({ status, diagnostic,
  listingConfirmed: false, allowPublic: false });
function paths(root, inventoryId) {
  if (typeof root !== "string" || !isAbsolute(root) || inventoryId !== INVENTORY)
    throw Error("DRAFT_SAVE_TARGET_UNVERIFIED");
  const dir = join(root, "general-private-draft-save-once");
  return { dir, claim: join(dir, `${inventoryId}.claim.json`),
    result: join(dir, `${inventoryId}.result.json`),
    confirmation: join(dir, `${inventoryId}.confirmation.json`),
    formResult: join(root, "general-private-create-once",
      `${inventoryId}.result.json`) };
}
async function writeOnce(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync(); }
  finally { await handle.close(); }
}
async function readOptional(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
const validAssets = (assets, count) => Array.isArray(assets) &&
  assets.length === count && assets.every(asset =>
    HASH.test(asset?.pathHash ?? "") &&
    Number.isSafeInteger(asset.width) && asset.width > 0 &&
    Number.isSafeInteger(asset.height) && asset.height > 0);
const exactSourceSnapshot = (snapshot, pack, form) =>
  snapshot?.sourcePriceYen === 50_000 &&
  snapshot.sourceShippingMethod === "KAZAI" &&
  Array.isArray(snapshot.files) && snapshot.files.length === 1 &&
  snapshot.files[0]?.storageKey === pack.imageRefs[0].storageKey &&
  snapshot.files[0]?.sha256 === form.selectedImageSha256s[0];

/** Human-selected fixed settings are compared with the current BELLO pack. */
export function inspectB005396DraftSaveInput(pack, form) {
  const exact = exactGeneralPrivateCreatePack(pack);
  if (!exact || exact.inventoryId !== INVENTORY ||
      exact.priceYen !== 99_999 || exact.quantity !== 1 ||
      exact.categoryPath !== CATEGORY || exact.condition !== "NO_NOTABLE_DAMAGE" ||
      exact.brandId !== null || exact.brandName !== null ||
      exact.imageRefs.length !== 1 || form?.status !== "FORM_READY_NO_SAVE" ||
      form.allowSave !== false || form.listingConfirmed !== false ||
      !UUID.test(form.attemptId ?? "") ||
      !ID.test(form.observedDraftId ?? "") ||
      !Number.isFinite(form.documentTimeOrigin) ||
      form.documentTimeOrigin <= 0 ||
      !Array.isArray(form.selectedImageSha256s) ||
      form.selectedImageSha256s.length !== 1 ||
      !HASH.test(form.selectedImageSha256s[0]) ||
      !validAssets(form.selectedAssets, 1) ||
      form.retainedSession?.page == null ||
      form.retainedSession?.context == null)
    return "FORM_OR_PACK_UNVERIFIED";
  return null;
}

/** No producer is wired yet; a read-only scan must prove exactly this draft. */
export function inspectB005396DraftDuplicateProof(pack, form, proof,
  now = Date.now()) {
  let status, shopId, managementCode, ownDraftId, observedAt,
    complete, allowFinalCreate;
  try { ({ status, shopId, managementCode, ownDraftId, observedAt,
    complete, allowFinalCreate } = proof ?? {}); }
  catch { return false; }
  return status === "NO_OTHER_MATCH_OBSERVED" && complete === true &&
    allowFinalCreate === false && shopId === pack.shopId &&
    managementCode === pack.managementCode &&
    ownDraftId === form.observedDraftId &&
    typeof observedAt === "string" &&
    Number.isFinite(Date.parse(observedAt)) &&
    Number.isFinite(now) && Date.parse(observedAt) <= now &&
    now - Date.parse(observedAt) <= 120_000;
}

/** One synchronous DOM evaluation pins every field and image to one page state. */
export async function readAtomicGeneralPrivateDraftFormSnapshot(page) {
  const beforeUrl = page.url();
  const raw = await page.locator("body").evaluate(() => {
    const names = ["name", "description", "price", "variants.0.quantity",
      "variants.0.skuCode", "shippingMethodType.id",
      "shippingPayerType.id", "shippingFromState.id",
      "shippingDurationType.id"];
    const fields = Object.fromEntries(names.map(name =>
      [name, document.querySelector(`[name="${name}"]`)?.value ?? null]));
    const images = [...document.querySelectorAll('img[alt="uploaded-image"]')]
      .map(image => {
        if (!(image instanceof HTMLImageElement) || !image.complete ||
            image.naturalWidth < 1 || image.naturalHeight < 1) return null;
        try { const url = new URL(image.currentSrc || image.src);
          return url.protocol === "https:" ? { pathname: url.pathname,
            width: image.naturalWidth, height: image.naturalHeight } : null;
        } catch { return null; }
      });
    return { href: document.location.href,
      timeOrigin: performance.timeOrigin, fields, images,
      condition: document.querySelector('[data-testid="condition-select-box"]')
        ?.textContent ?? null,
      categoryLeaf: document.querySelector('[data-testid="categories"]')
        ?.textContent ?? null,
      categoryGroup: document.querySelector('label[for="category"]')
        ?.closest('[role="group"]')?.textContent ?? null };
  });
  if (page.url() !== beforeUrl || raw?.href !== beforeUrl ||
      !Array.isArray(raw.images) || raw.images.length < 1 ||
      raw.images.length > 20 || raw.images.some(image => !image ||
        typeof image.pathname !== "string" ||
        !image.pathname.startsWith("/") ||
        !Number.isSafeInteger(image.width) || image.width < 1 ||
        !Number.isSafeInteger(image.height) || image.height < 1))
    return null;
  return { ...raw, assets: raw.images.map(image => ({
    pathHash: createHash("sha256").update(image.pathname).digest("hex"),
    width: image.width, height: image.height,
  })) };
}

export async function exactFormStillOpen(pack, form, page,
  { readSnapshot = readAtomicGeneralPrivateDraftFormSnapshot } = {}) {
  const beforeUrl = page.url();
  const url = inspectGeneralPrivateCreateUrl(beforeUrl, pack.shopId);
  if (!url.valid || url.draftId !== form.observedDraftId)
    return false;
  let snapshot;
  try { snapshot = await readSnapshot(page); } catch { return false; }
  if (!snapshot || snapshot.href !== beforeUrl ||
      snapshot.timeOrigin !== form.documentTimeOrigin ||
      !same(snapshot.assets, form.selectedAssets) ||
      page.url() !== beforeUrl ||
      snapshot.categoryLeaf?.trim() !== pack.categoryPath.split(" > ").at(-1))
    return false;
  const fields = snapshot.fields ?? {};
  const view = { name: fields.name, description: fields.description,
    price: fields.price, quantity: fields["variants.0.quantity"],
    sku: fields["variants.0.skuCode"], condition: snapshot.condition,
    category: snapshot.categoryGroup,
    shipping: Object.fromEntries(Object.keys({
      "shippingMethodType.id": 1, "shippingPayerType.id": 1,
      "shippingFromState.id": 1, "shippingDurationType.id": 1,
    }).map(name => [name, fields[name]])), imageCount: snapshot.assets.length };
  return diagnoseGeneralPrivateCreateForm(pack, view) === null;
}

/**
 * Unwired draft-save pathway. The default duplicate reader is absent, so a
 * live call stops before the draft button. No public control is addressed.
 */
export async function saveB005396PrivateDraftOnce({ root, inventoryId, form,
  origin, belloProfileDir, playwrightModulePath }, {
    fetchSnapshot = fetchCurrentGeneralPrivateCreateSnapshot,
    captureDuplicateProof = null,
    gate = withShopListingSend,
    verifyForm = exactFormStillOpen,
  } = {}) {
  const { pack, fingerprint } = await readGeneralPrivateCreate(root, inventoryId);
  const issue = inspectB005396DraftSaveInput(pack, form);
  if (issue) return fixed("BLOCKED", issue);
  const path = paths(root, inventoryId);
  const formClaim = await readGeneralPrivateCreateClaim(root, inventoryId);
  const formResult = await readOptional(path.formResult);
  if (!formClaim || formClaim.attemptId !== form.attemptId ||
      formClaim.fingerprint !== fingerprint ||
      formResult?.attemptId !== form.attemptId ||
      formResult.outcome !== "UNKNOWN" ||
      formResult.reasonCode !== "FORM_READY_NO_SAVE" ||
      formResult.observedDraftId !== form.observedDraftId)
    return fixed("BLOCKED", "FORM_CLAIM_UNVERIFIED");
  if (await readOptional(path.claim))
    return fixed("BLOCKED", "DRAFT_SAVE_ALREADY_CLAIMED");
  if (typeof captureDuplicateProof !== "function")
    return fixed("BLOCKED", "REMOTE_DUPLICATE_UNVERIFIED");
  let source;
  try { source = await fetchSnapshot({ origin, belloProfileDir,
    playwrightModulePath, pack }); }
  catch { return fixed("BLOCKED", "SOURCE_CHANGED"); }
  if (!exactSourceSnapshot(source, pack, form))
    return fixed("BLOCKED", "SOURCE_CHANGED");

  await mkdir(path.dir, { recursive: true });
  const claim = { schemaVersion: 1, operation: "PRIVATE_DRAFT_SAVE_ONCE",
    attemptId: randomUUID(), formAttemptId: form.attemptId,
    inventoryId, shopId: pack.shopId, fingerprint,
    draftId: form.observedDraftId, selectedAssets: form.selectedAssets,
    shippingReviewRequired: true,
    claimedAt: new Date().toISOString(), status: "UNKNOWN" };
  try { await writeOnce(path.claim, claim); }
  catch (error) { if (error?.code === "EEXIST")
    return fixed("BLOCKED", "DRAFT_SAVE_ALREADY_CLAIMED");
    throw error; }
  let reasonCode = "SEND_GATE_UNAVAILABLE";
  let clicked = false;
  try {
    await gate(root, { shopId: pack.shopId, inventoryId,
      operation: "CREATE", attemptId: claim.attemptId }, async () => {
      reasonCode = "SOURCE_CHANGED";
      const current = await fetchSnapshot({ origin, belloProfileDir,
        playwrightModulePath, pack });
      if (!exactSourceSnapshot(current, pack, form))
        throw Error("SOURCE_CHANGED");
      reasonCode = "REMOTE_DUPLICATE_UNVERIFIED";
      const proof = await captureDuplicateProof({ shopId: pack.shopId,
        managementCode: pack.managementCode,
        ownDraftId: form.observedDraftId, title: pack.title });
      if (!inspectB005396DraftDuplicateProof(pack, form, proof))
        throw Error("REMOTE_DUPLICATE_UNVERIFIED");
      reasonCode = "FORM_CHANGED";
      const page = form.retainedSession.page;
      if (!await verifyForm(pack, form, page)) throw Error("FORM_CHANGED");
      const button = page.getByRole("button", {
        name: "下書きへ保存する", exact: true });
      reasonCode = "DRAFT_BUTTON_UNVERIFIED";
      if (await button.count() !== 1 || !await button.isEnabled())
        throw Error("DRAFT_BUTTON_UNVERIFIED");
      const handle = await button.elementHandle();
      if (!handle || !await handle.isEnabled() ||
          !await verifyForm(pack, form, page))
        throw Error("DRAFT_BUTTON_UNVERIFIED");
      reasonCode = "DRAFT_SAVE_CLICK_UNCERTAIN";
      clicked = true;
      await handle.click({ timeout: 12000 });
      reasonCode = "DRAFT_SAVE_READBACK_UNVERIFIED";
    });
  } catch { /* The claimed save is UNKNOWN and must not be clicked again. */ }
  if (!UNKNOWN_REASONS.has(reasonCode)) reasonCode = "SEND_GATE_UNAVAILABLE";
  await writeOnce(path.result, { schemaVersion: 1,
    attemptId: claim.attemptId, inventoryId, outcome: "UNKNOWN",
    reasonCode, clicked, observedDraftId: form.observedDraftId,
    listingConfirmed: false, shippingReviewRequired: true,
    recordedAt: new Date().toISOString() });
  return { status: "UNKNOWN", diagnostic: reasonCode, clicked,
    listingConfirmed: false, allowPublic: false,
    shippingReviewRequired: true,
    observedDraftId: form.observedDraftId,
    retainedSession: form.retainedSession };
}

/** Later reconciliation is read-only and does not replay the draft-save click. */
export async function reconcileB005396PrivateDraftSaveUnknown({ root,
  inventoryId, readDraft = null }) {
  const path = paths(root, inventoryId);
  const claim = await readOptional(path.claim);
  const result = await readOptional(path.result);
  const { pack, fingerprint } = await readGeneralPrivateCreate(root, inventoryId);
  if (claim?.schemaVersion !== 1 ||
      claim.operation !== "PRIVATE_DRAFT_SAVE_ONCE" ||
      claim.inventoryId !== inventoryId || claim.shopId !== pack.shopId ||
      claim.fingerprint !== fingerprint || claim.status !== "UNKNOWN" ||
      claim.shippingReviewRequired !== true ||
      !UUID.test(claim.attemptId ?? "") ||
      !UUID.test(claim.formAttemptId ?? "") ||
      !ID.test(claim.draftId ?? "") ||
      !validAssets(claim.selectedAssets, pack.imageRefs.length) ||
      result?.schemaVersion !== 1 || result.inventoryId !== inventoryId ||
      result.attemptId !== claim.attemptId || result.outcome !== "UNKNOWN" ||
      result.listingConfirmed !== false ||
      result.shippingReviewRequired !== true ||
      typeof readDraft !== "function")
    return fixed("UNKNOWN", "DRAFT_SAVE_READBACK_UNVERIFIED");
  let proof;
  try { proof = await readDraft({ shopId: claim.shopId,
    draftId: claim.draftId, managementCode: pack.managementCode }); }
  catch { return fixed("UNKNOWN", "DRAFT_SAVE_READBACK_UNVERIFIED"); }
  let observed;
  try { observed = { status: proof?.status, shopId: proof?.shopId,
    draftId: proof?.draftId, managementCode: proof?.managementCode,
    title: proof?.title, description: proof?.description,
    priceYen: proof?.priceYen, quantity: proof?.quantity,
    condition: proof?.condition, categoryPath: proof?.categoryPath,
    shipping: proof?.shipping, assets: proof?.assets,
    visibility: proof?.visibility, public: proof?.public,
    observedAt: proof?.observedAt }; }
  catch { return fixed("UNKNOWN", "DRAFT_SAVE_READBACK_UNVERIFIED"); }
  if (observed.status !== "PRIVATE_DRAFT_READBACK_CONFIRMED" ||
      observed.visibility !== "DRAFT_PRIVATE" || observed.public !== false ||
      typeof observed.observedAt !== "string" ||
      !Number.isFinite(Date.parse(observed.observedAt)) ||
      Date.parse(observed.observedAt) > Date.now() ||
      Date.now() - Date.parse(observed.observedAt) > 120_000 ||
      observed.shopId !== claim.shopId ||
      observed.draftId !== claim.draftId ||
      observed.managementCode !== pack.managementCode ||
      observed.title !== pack.title ||
      observed.description !== pack.description ||
      observed.priceYen !== pack.priceYen ||
      observed.quantity !== pack.quantity ||
      observed.condition !== pack.condition ||
      observed.categoryPath !== pack.categoryPath ||
      !same(observed.shipping, pack.shipping) ||
      !same(observed.assets, claim.selectedAssets))
    return fixed("UNKNOWN", "DRAFT_SAVE_READBACK_UNVERIFIED");
  try { await writeOnce(path.confirmation, { schemaVersion: 1,
    attemptId: claim.attemptId, inventoryId,
    status: "PRIVATE_DRAFT_READBACK_CONFIRMED",
    listingConfirmed: false, public: false,
    shippingReviewRequired: true,
    recordedAt: new Date().toISOString() }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  return fixed("PRIVATE_DRAFT_READBACK_CONFIRMED", "PRIVATE_DRAFT_READBACK_CONFIRMED");
}
