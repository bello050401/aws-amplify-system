import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectExistingImage } from "./prepareExistingImage.mjs";
import { buildPrivateCreatePreparation, PRIVATE_CREATE_SHOP_ID } from
  "./privateCreatePreparation.mjs";
import { openFutureCreateTrafficObservationSession } from "./session.mjs";
import { recordFutureCreateObservationOnce } from "./futureCreateObservationAttempt.mjs";
import { readExistingUploadedImages } from "./addExistingImageOnce.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";

const INVENTORY = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const SOURCE_PUBLIC_ID = "2JWp7EJx6aqKfn6dTXc5Q9";
const OLD_UNATTRIBUTED_DRAFT = "2JXmhh6wZFnKBnhwk8zV9c";
const CODE = "TEST_B005659_E51E4F6B7B86DD150546";
const IMAGE_SHA256 = "f3ad2f02b497e46e120f8314f597afad552bf4068ae2d5a436905a532d45e76b";
const PREPARED_FINGERPRINT = "63ec8ca8b8a390fb58f67b5fac09cd3d0fd8641aa82aee164bc67b07d55c81be";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const LIST_URL = `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products?tab=on_sale&visibility=unopened`;
const CREATE_PATH = `/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create`;
const FIXED_SHIPPING = Object.freeze({
  "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
  "shippingPayerType.id": "PAYER_TYPE_SELLER",
  "shippingFromState.id": "jp11",
  "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS",
});

const digest = value => createHash("sha256").update(value).digest("hex");

/** Fixed labels only: never persist a browser URL or its query values. */
export function classifyPrivateCreateListEntry(state, rawUrl) {
  if (state === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  try {
    const url = new URL(rawUrl);
    if (url.href === LIST_URL) return "EXACT_LIST";
    if (url.origin !== "https://mercari-shops.com") return "OTHER_ORIGIN";
    if (url.pathname.startsWith("/signin/")) return "SIGN_IN";
    if (url.pathname === `/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products`)
      return "LIST_FILTER_CHANGED";
    return "OTHER_SHOPS_PAGE";
  } catch { return "INVALID_URL"; }
}

/** Review aid only. This never changes a claim or authorizes another attempt. */
export function eligibleForPinnedPrivateCreateNotSent({ claim, result,
  observation, readback } = {}) {
  const after = (later, earlier) => typeof later === "string" &&
    typeof earlier === "string" && Number.isFinite(Date.parse(later)) &&
    Number.isFinite(Date.parse(earlier)) && Date.parse(later) > Date.parse(earlier);
  const zeroSearch = value => value?.complete === true &&
    value?.managementCodeMatches === 0 && value?.titleMatches === 0 &&
    value?.price99999Matches === 0;
  return claim?.shopId === PRIVATE_CREATE_SHOP_ID &&
    claim.operation === "OBSERVE_FUTURE_PRIVATE_CREATE_ONCE" &&
    claim.outcome === "UNKNOWN" &&
    claim.listingConfirmed === false &&
    typeof claim.attemptId === "string" && ID.test(claim.attemptId) &&
    result?.attemptId === claim.attemptId &&
    result.shopId === claim.shopId &&
    result.inventoryFingerprint === claim.inventoryFingerprint &&
    result.snapshotFingerprint === claim.snapshotFingerprint &&
    result.outcome === "UNKNOWN" && result.remoteId === null &&
    result.listingConfirmed === false && result.diagnosticStage === "CLAIMED" &&
    ["LIST_UNAVAILABLE", "LINK_UNAVAILABLE", "LIST_CHANGED"].includes(result.reasonCode) &&
    result.attempted?.createClick === false &&
    result.attempted.fieldsOrFile === false &&
    result.attempted.privateSaveClick === false &&
    result.observationCaptureStatus === "UNVERIFIED" &&
    observation?.attemptId === claim.attemptId &&
    observation.outcome === "OBSERVED_UNVERIFIED" &&
    observation.captureStatus === "UNVERIFIED" &&
    Array.isArray(observation.events) && observation.events.length === 0 &&
    Array.isArray(observation.draftIds) && observation.draftIds.length === 0 &&
    readback?.shopId === claim.shopId &&
    readback.inventoryId === INVENTORY &&
    readback.managementCode === CODE &&
    readback.priceYen === 99999 &&
    zeroSearch(readback.onSaleAllVisibility) &&
    zeroSearch(readback.draftAllPages) &&
    after(result.recordedAt, claim.claimedAt) &&
    after(readback.observedAt, result.recordedAt);
}

async function waitForExactPrivateCreateList(session) {
  if (session.state === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (classifyPrivateCreateListEntry(session.state, session.page.url()) !== "EXACT_LIST") {
    try { await session.page.waitForURL(LIST_URL, { timeout: 8000 }); }
    catch { /* A failed or changing navigation remains a no-click result. */ }
  }
  return classifyPrivateCreateListEntry(session.state, session.page.url());
}
const keys = value => Object.keys(value).sort().join(",");
const sameJob = (left, right) => keys(left) === keys(right) &&
  Object.keys(left).every(key => left[key] === right[key]);

/** Pure boundary. No browser is opened and no claim is consumed. */
export function exactPinnedPrivateCreateJob(job) {
  let snapshot;
  try { snapshot = JSON.parse(job?.snapshotJson); } catch { return null; }
  let expected;
  try { expected = buildPrivateCreatePreparation(snapshot); }
  catch { return null; }
  if (!sameJob(job, expected) || job.schemaVersion !== 2 ||
      job.inventoryId !== INVENTORY || job.shopId !== PRIVATE_CREATE_SHOP_ID ||
      job.snapshotFingerprint !== PREPARED_FINGERPRINT ||
      job.status !== "PREPARED_NO_SEND" || job.remoteId !== null ||
      job.listingConfirmed !== false || snapshot.testManagementCode !== CODE ||
      snapshot.testPriceYen !== 99999 || snapshot.visibility !== "PRIVATE_ONLY" ||
      snapshot.doNotModifyProductId !== SOURCE_PUBLIC_ID ||
      snapshot.imageRefs?.length !== 1) return null;
  return { job, snapshot };
}

export function exactNewDraftId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== "https://mercari-shops.com" || url.pathname !== CREATE_PATH)
      return { valid: false, id: null };
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return { valid: true, id: null };
    if (keys.length !== 1 || keys[0] !== "productDraftId")
      return { valid: false, id: null };
    const id = url.searchParams.get("productDraftId");
    if (!id || !ID.test(id) || id === SOURCE_PUBLIC_ID ||
        id === OLD_UNATTRIBUTED_DRAFT) return { valid: false, id: null };
    return { valid: true, id };
  } catch { return { valid: false, id: null }; }
}

export function exactPrivateCreateResponse(observation) {
  if (observation?.captureStatus !== "UNVERIFIED" ||
      !Array.isArray(observation.events) ||
      !Array.isArray(observation.draftIds) ||
      observation.draftIds.length > 1 ||
      observation.draftIds.some(item => item.id === OLD_UNATTRIBUTED_DRAFT ||
        item.id === SOURCE_PUBLIC_ID)) return null;
  // A second createProduct response is a conflict even when it is public,
  // protected, or unsuccessful. Never select only the convenient private one.
  const responses = observation.events.filter(event =>
    event.resultId !== null && event.resultId !== undefined ||
    event.responseJsonKeys?.some(path =>
      path === "data.createProduct" || path.startsWith("data.createProduct.")));
  if (responses.length !== 1) return null;
  const response = responses[0];
  return response.httpStatus === 200 && ID.test(response.resultId ?? "") &&
    ["UNOPENED", "PRIVATE"].includes(response.resultState) &&
    response.resultId !== SOURCE_PUBLIC_ID &&
    response.resultId !== OLD_UNATTRIBUTED_DRAFT ? response.resultId : null;
}

/** Text is compared byte-for-byte; only the displayed yen price may be formatted. */
export function exactFormFieldReadback(name, actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (name !== "price") return actual === expected;
  if (!/^[0-9]+$/.test(expected) ||
      !/^(?:[¥￥]\s*)?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(actual))
    return false;
  return Number(actual.replace(/[¥￥,\s]/g, "")) === Number(expected);
}

export function sameUploadedAsset(selected, saved) {
  return selected?.length === 1 && saved?.length === 1 &&
    /^[a-f0-9]{64}$/.test(selected[0]?.pathHash ?? "") &&
    selected[0].pathHash === saved[0]?.pathHash &&
    selected[0].width === saved[0]?.width &&
    selected[0].height === saved[0]?.height;
}

async function readPrepared(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw Error("Absolute queue root required");
  const path = join(root, "private-create-prepared", `${INVENTORY}.json`);
  const bytes = await readFile(path);
  if (bytes.length > 65536) throw Error("Prepared job too large");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw Error("Pinned B005659 preparation invalid"); }
  const prepared = exactPinnedPrivateCreateJob(parsed);
  if (!prepared) throw Error("Pinned B005659 preparation changed");
  return prepared;
}

export async function preflightPinnedPrivateCreateUi({ root, imagePath,
  expectedImageSha256 = IMAGE_SHA256 }) {
  if (typeof imagePath !== "string" || !isAbsolute(imagePath) ||
      expectedImageSha256 !== IMAGE_SHA256)
    throw Error("Pinned private-create image path required");
  const { job, snapshot } = await readPrepared(root);
  const imageBytes = await readFile(imagePath);
  const image = inspectExistingImage(imageBytes,
    { inventoryCode: "B005659", expectedSha256: expectedImageSha256 });
  return { job, snapshot, imageBytes, image };
}

async function unique(locator) {
  if (await locator.count() !== 1 || !await locator.isEnabled())
    throw Error("Shops control changed");
  return locator;
}

async function fillOnce(page, snapshot, imageBytes, image, seenDrafts) {
  const checkpoint = () => {
    const draft = exactNewDraftId(page.url());
    if (!draft.valid) throw Error("Shops create URL changed");
    if (draft.id) seenDrafts.add(draft.id);
    if (seenDrafts.size > 1) throw Error("Multiple draft IDs observed");
  };
  checkpoint();
  const fields = [
    ["name", snapshot.title], ["description", snapshot.description],
    ["price", String(snapshot.testPriceYen)],
    ["variants.0.quantity", String(snapshot.quantity)],
    ["variants.0.skuCode", snapshot.testManagementCode],
  ];
  for (const [name, value] of fields) {
    await (await unique(page.locator(`[name="${name}"]`))).fill(value, { timeout: 12000 });
    checkpoint();
  }
  for (const [name, value] of Object.entries(FIXED_SHIPPING)) {
    await (await unique(page.locator(`select[name="${name}"]`))).selectOption(value,
      { timeout: 12000 });
    checkpoint();
  }
  const condition = await unique(page.getByTestId("condition-select-box"));
  if (!(await condition.innerText()).includes("目立った傷や汚れなし"))
    throw Error("Saved condition is not selected");
  const categories = await unique(page.getByTestId("categories"));
  await categories.click({ timeout: 12000 });
  checkpoint();
  for (const label of ["家具・インテリア", "リビング収納", "テレビ台"]) {
    const modal = page.getByRole("dialog");
    if (await modal.count() !== 1) throw Error("Category dialog changed");
    await (await unique(modal.getByText(label, { exact: true }))).click({ timeout: 12000 });
    checkpoint();
  }
  if (!(await categories.innerText()).includes("テレビ台"))
    throw Error("Exact leaf category was not selected");
  const input = page.locator('input[type="file"][multiple]');
  const preview = page.locator('img[alt="uploaded-image"]');
  if (await preview.count() !== 0) throw Error("Create draft already has an image");
  await (await unique(input)).setInputFiles({ name: image.filename,
    mimeType: image.mimeType, buffer: imageBytes }, { timeout: 12000 });
  checkpoint();
  await preview.first().waitFor({ state: "visible", timeout: 30000 });
  if (await preview.count() !== 1) throw Error("Selected image count changed");
  const assetUrl = page.url();
  const selectedAsset = await readExistingUploadedImages(page, assetUrl);
  if (selectedAsset?.length !== 1) throw Error("Selected image asset unavailable");
  checkpoint();
  const values = await page.locator("input,textarea,select").evaluateAll(elements =>
    Object.fromEntries(elements.filter(element => element.name).map(element =>
      [element.name, element.value])));
  for (const [name, value] of [...fields, ...Object.entries(FIXED_SHIPPING)]) {
    if (!exactFormFieldReadback(name, values[name], value))
      throw Error("Shops field readback differs");
  }
  if (!sameUploadedAsset(selectedAsset,
      await readExistingUploadedImages(page, page.url())))
    throw Error("Selected image asset changed before save");
  checkpoint();
  return selectedAsset;
}

async function verifyReadback(context, remoteId, snapshot, selectedAsset) {
  const url = `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/${remoteId}/edit`;
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (page.url() !== url) return false;
    const data = await page.locator("body").evaluate(() => {
      const field = name => document.querySelector(`[name="${name}"]`)?.value ?? null;
      const group = document.querySelector('label[for="category"]')?.closest('[role="group"]');
      return { name: field("name"), description: field("description"),
        price: field("price"), quantity: field("variants.0.quantity"),
        sku: field("variants.0.skuCode"),
        condition: document.querySelector('[data-testid="condition-select-box"]')?.textContent ?? null,
        category: group?.textContent ?? null,
        shipping: Object.fromEntries(Object.keys({
          "shippingMethodType.id": 1, "shippingPayerType.id": 1,
          "shippingFromState.id": 1, "shippingDurationType.id": 1,
        }).map(name => [name, field(name)])) };
    });
    if (data.name !== snapshot.title || data.description !== snapshot.description ||
        !exactFormFieldReadback("price", data.price, String(snapshot.testPriceYen)) ||
        data.quantity !== "1" || data.sku !== CODE ||
        !data.condition?.includes("目立った傷や汚れなし") ||
        !data.category?.includes("家具・インテリア") ||
        !data.category?.includes("リビング収納") ||
        !data.category?.includes("テレビ台") ||
        Object.entries(FIXED_SHIPPING).some(([name, value]) =>
          data.shipping[name] !== value)) return false;
    const images = await readExistingUploadedImages(page, url);
    if (!sameUploadedAsset(selectedAsset, images)) return false;
    const privateRow = await privateFromExactListRow(page, PRIVATE_CREATE_SHOP_ID,
      url, snapshot.title);
    return privateRow.value.kind === "OBSERVED" &&
      privateRow.value.value === "PRIVATE" && page.url() === url;
  } catch { return false; }
  finally { await page.close().catch(() => {}); }
}

async function writeResultOnce(root, result) {
  const dir = join(root, "future-private-create-ui-once");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${PRIVATE_CREATE_SHOP_ID}-once.result.json`);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(result) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** One normal-browser create, never a direct Shops HTTP call. Any uncertainty stays non-retryable. */
export async function runPinnedPrivateCreateUiOnce({ root, profileDir,
  playwrightModulePath, imagePath, expectedImageSha256 = IMAGE_SHA256 }, {
    openSession = openFutureCreateTrafficObservationSession,
    preflight = preflightPinnedPrivateCreateUi,
    recordObservation = recordFutureCreateObservationOnce,
    saveResult = writeResultOnce,
  } = {}) {
  if (![root, profileDir, playwrightModulePath, imagePath].every(value =>
      typeof value === "string" && isAbsolute(value)) ||
      expectedImageSha256 !== IMAGE_SHA256)
    throw Error("Pinned private-create inputs required");
  const { job, snapshot, imageBytes, image } =
    await preflight({ root, imagePath, expectedImageSha256 });
  let session;
  try {
    session = await openSession({ root, profileDir, playwrightModulePath,
      inventoryId: INVENTORY });
  } catch (error) {
    if (!ID.test(error?.claim?.attemptId ?? "") ||
        error.claim.shopId !== PRIVATE_CREATE_SHOP_ID) throw error;
    const result = { schemaVersion: 1, attemptId: error.claim.attemptId,
      shopId: PRIVATE_CREATE_SHOP_ID, inventoryFingerprint: digest(INVENTORY),
      snapshotFingerprint: job.snapshotFingerprint, outcome: "UNKNOWN", remoteId: null,
      visibility: null, listingConfirmed: false,
      diagnosticStage: "BROWSER_UNAVAILABLE", observedDraftCount: 0,
      entryDiagnostic: "BROWSER_UNAVAILABLE",
      reasonCode: "BROWSER_UNAVAILABLE",
      attempted: { createClick: false, fieldsOrFile: false,
        privateSaveClick: false }, observationCaptureStatus: "MISSING",
      recordedAt: new Date().toISOString() };
    await saveResult(root, result);
    return { status: "UNKNOWN", remoteId: null,
      listingConfirmed: false, retainedSession: null };
  }
  const seenDrafts = new Set();
  let stage = "CLAIMED";
  let entryDiagnostic = "NOT_CHECKED";
  let reasonCode = "PRE_CLICK_UNVERIFIED";
  const attempted = { createClick: false, fieldsOrFile: false,
    privateSaveClick: false };
  let observation = null;
  let remoteId = null;
  try {
    entryDiagnostic = await waitForExactPrivateCreateList(session);
    if (entryDiagnostic !== "EXACT_LIST") {
      reasonCode = "LIST_UNAVAILABLE";
      throw Error("Dedicated Shops login or list unavailable");
    }
    const createLink = session.page.getByRole("link", { name: "商品登録", exact: true });
    try { await createLink.waitFor({ state: "visible", timeout: 8000 }); }
    catch {
      entryDiagnostic = "LINK_UNAVAILABLE";
      reasonCode = "LINK_UNAVAILABLE";
      throw Error("Dedicated Shops create link unavailable");
    }
    entryDiagnostic = classifyPrivateCreateListEntry(session.state, session.page.url());
    if (entryDiagnostic !== "EXACT_LIST") {
      reasonCode = "LIST_CHANGED";
      throw Error("Dedicated Shops list changed before create");
    }
    let create;
    try { create = await unique(createLink); }
    catch {
      entryDiagnostic = "LINK_UNAVAILABLE";
      reasonCode = "LINK_UNAVAILABLE";
      throw Error("Dedicated Shops create link unavailable");
    }
    stage = "CREATE_PAGE_UNCERTAIN";
    reasonCode = "CREATE_CLICK_UNCERTAIN";
    attempted.createClick = true;
    await create.click({ timeout: 12000 });
    const page = session.page;
    if (!exactNewDraftId(page.url()).valid) throw Error("Create page unavailable");
    stage = "FIELDS_UNCERTAIN";
    reasonCode = "FIELDS_OR_FILE_UNCERTAIN";
    attempted.fieldsOrFile = true;
    const selectedAsset = await fillOnce(page, snapshot, imageBytes, image, seenDrafts);
    const next = await unique(page.getByRole("button", { name: "公開設定に進む", exact: true }));
    stage = "PRIVATE_DIALOG_UNCERTAIN";
    reasonCode = "PRIVATE_DIALOG_UNCERTAIN";
    await next.click({ timeout: 12000 });
    if (!exactNewDraftId(page.url()).valid) throw Error("Create URL changed before private save");
    const dialog = page.getByRole("dialog");
    if (await dialog.count() !== 1 ||
        await dialog.getByRole("button", { name: "公開する", exact: true }).count() !== 1)
      throw Error("Private save dialog changed");
    const privateButton = await unique(dialog.getByRole("button",
      { name: "非公開で保存する", exact: true }));
    stage = "PRIVATE_SAVE_UNCERTAIN";
    reasonCode = "PRIVATE_SAVE_CLICK_UNCERTAIN";
    // Attach before the click: the create response may arrive after click resolves.
    const responseWait = session.observer.waitForCreateProductResponse(12000);
    attempted.privateSaveClick = true;
    await privateButton.click({ timeout: 12000 });
    if (!await responseWait) throw Error("Create response timed out");
    await new Promise(resolve => setTimeout(resolve, 500));
    observation = await session.observer.stop();
    remoteId = exactPrivateCreateResponse(observation);
    if (!remoteId) throw Error("Exact private create response unavailable");
    stage = "READBACK_UNCERTAIN";
    reasonCode = "READBACK_UNCERTAIN";
    if (!await verifyReadback(session.context, remoteId, snapshot, selectedAsset))
      throw Error("Independent private product readback unavailable");
    stage = "PRIVATE_CONFIRMED";
    reasonCode = "PRIVATE_CONFIRMED";
  } catch { /* The claim is permanent even when login, form, upload, or save is uncertain. */ }
  finally {
    if (!observation) observation = await session.observer?.stop().catch(() => null);
    if (observation) {
      await recordObservation(root, INVENTORY,
        session.claim.attemptId, observation).catch(() => {});
    }
  }
  const confirmed = stage === "PRIVATE_CONFIRMED";
  const result = { schemaVersion: 1, attemptId: session.claim.attemptId,
    shopId: PRIVATE_CREATE_SHOP_ID, inventoryFingerprint: digest(INVENTORY),
    snapshotFingerprint: job.snapshotFingerprint,
    outcome: confirmed ? "PRIVATE_CONFIRMED" : "UNKNOWN",
    remoteId: confirmed ? remoteId : null,
    visibility: confirmed ? "PRIVATE" : null,
    listingConfirmed: confirmed, diagnosticStage: stage, entryDiagnostic,
    reasonCode, attempted, observationCaptureStatus:
      observation?.captureStatus ?? "MISSING",
    observedDraftCount: seenDrafts.size, recordedAt: new Date().toISOString() };
  await saveResult(root, result);
  if (confirmed) await session.context.close().catch(() => {});
  return { status: result.outcome, remoteId: result.remoteId,
    listingConfirmed: result.listingConfirmed,
    retainedSession: confirmed ? null : session };
}
