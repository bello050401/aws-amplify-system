import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";
import { openVisibilityTransitionSession } from "./session.mjs";
import { readExactVisibilityFromList } from "./visibilityReadback.mjs";
import { planVisibilityTransition } from "./visibilityTransitionPlan.mjs";
import { readPinnedEditFields, privateSaveControl } from "./saveExistingPrivateOnce.mjs";
import { MAX_MANUAL_MUTATION_EVENTS, observeManualShopsMutation,
  safeManualMutationSummary } from
  "./manualMutationObservation.mjs";
import { withShopListingSend } from "./listingSendGate.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED_PUBLIC_IDS = new Set(["2JWp7EJx6aqKfn6dTXc5Q9",
  "2JToDtSgGowzUwnwe9hgHU"]);
const PRIVATE_ONLY_INVENTORIES = new Set([
  "dd273c1e-9b2a-4013-acc6-c445a481fab8",
  "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
]);
const RESERVED_TEST_CODES = new Set(["B005659", "TEST_B005659_E51E4F6B7B86DD150546",
  "B005413", "TEST_B005413_B63EF3F86211FFE0F890D81E"]);
const TARGET_KEYS = ["shopId", "inventoryId", "remoteId", "title", "skuCode",
  "priceYen", "quantity", "visibilityPolicy"];
const hash = value => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function exactVisibilityTarget(target) {
  return exactKeys(target, TARGET_KEYS) && target.shopId === PRIVATE_CREATE_SHOP_ID &&
    typeof target.inventoryId === "string" && UUID.test(target.inventoryId) &&
    !PRIVATE_ONLY_INVENTORIES.has(target.inventoryId.toLowerCase()) &&
    typeof target.remoteId === "string" && ID.test(target.remoteId) &&
    !PROTECTED_PUBLIC_IDS.has(target.remoteId) &&
    typeof target.title === "string" && target.title === target.title.trim() &&
    target.title.length >= 1 && target.title.length <= 130 &&
    !/[\x00-\x1f\x7f]/.test(target.title) &&
    typeof target.skuCode === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(target.skuCode) &&
    !RESERVED_TEST_CODES.has(target.skuCode.toUpperCase()) &&
    Number.isSafeInteger(target.priceYen) && target.priceYen >= 300 &&
    target.priceYen <= 9_999_999 && Number.isSafeInteger(target.quantity) &&
    target.quantity >= 0 &&
    target.visibilityPolicy === "PUBLIC_ALLOWED";
}

/** Validate the exact no-send job exported by the BELLO EC listing button. */
export function exactVisibilityPcJob(value) {
  if (!exactKeys(value, ["schemaVersion", "action", "target", "listing", "fingerprint"]) ||
      value.schemaVersion !== 1 || !["STOP", "RELIST"].includes(value.action) ||
      !exactVisibilityTarget(value.target) ||
      value.target.visibilityPolicy !== "PUBLIC_ALLOWED" ||
      !exactKeys(value.listing, ["status", "externalListingId"]) ||
      value.listing.status !== "ACTIVE" ||
      value.listing.externalListingId !== value.target.remoteId ||
      typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint))
    return false;
  const body = { schemaVersion: value.schemaVersion, action: value.action,
    target: value.target, listing: value.listing };
  return hash(JSON.stringify(body)) === value.fingerprint;
}

/** One exact mutation response, never a guessed HTTP request contract. */
export function exactVisibilityMutationAcknowledgement(raw, action) {
  // At the observer's capacity a later request may have been dropped. Never
  // certify a transition from a saturated or otherwise truncated window.
  if (!["STOP", "RELIST"].includes(action) || !Array.isArray(raw) ||
      raw.length >= MAX_MANUAL_MUTATION_EVENTS) return false;
  const events = safeManualMutationSummary(raw);
  if (events.length !== raw.length) return false;
  const mutations = events.filter(event => event.graphqlOperationType === "mutation" ||
    event.responseField === "updateProduct" || event.responseKind === "UPDATE_PRODUCT");
  if (mutations.length !== 1) return false;
  const event = mutations[0];
  return event.host === "mercari-shops.com" && event.path === "/graphql" &&
    event.graphqlOperationType === "mutation" && event.httpStatus === 200 &&
    event.responseField === "updateProduct" && event.responseKind === "UPDATE_PRODUCT" &&
    event.requestProductMatch === "MATCH" && event.productMatch === "MATCH" &&
    event.shopMatch === "MATCH" && event.graphqlErrors === "NONE" &&
    (action === "STOP" ? event.requestPrivateState === "MATCH" &&
      ["UNOPENED", "PRIVATE"].includes(event.state) :
      event.requestPublicState === "MATCH" &&
      ["OPENED", "PUBLIC"].includes(event.state));
}

const stem = (target, action) => `${target.shopId}-${target.remoteId}-${action}`;
const resultPath = (root, target, action) => join(root, "visibility-transition-once",
  `${stem(target, action)}.result.json`);

async function readVerifiedStop(root, target) {
  let saved;
  try { saved = JSON.parse(await readFile(resultPath(root, target, "STOP"), "utf8")); }
  catch { return null; }
  return saved?.schemaVersion === 1 && saved.action === "STOP" &&
    saved.outcome === "STOP_VERIFIED" && saved.shopId === target.shopId &&
    saved.inventoryId === target.inventoryId && saved.remoteId === target.remoteId &&
    saved.title === target.title && saved.targetFingerprint === hash(JSON.stringify(target)) &&
    saved.observedVisibility === "PRIVATE" &&
    typeof saved.attemptId === "string" && UUID.test(saved.attemptId) ?
      { kind: "STOP_VERIFIED", shopId: target.shopId, remoteId: target.remoteId,
        title: target.title, resultingVisibility: "PRIVATE" } : null;
}

export async function claimVisibilityTransitionOnce(root, action, target) {
  if (typeof root !== "string" || !isAbsolute(root) ||
      !["STOP", "RELIST"].includes(action) || !exactVisibilityTarget(target))
    throw Error("Invalid exact visibility transition target");
  const dir = join(root, "visibility-transition-once");
  await mkdir(dir, { recursive: true });
  const claim = { schemaVersion: 1, action, shopId: target.shopId,
    inventoryId: target.inventoryId, remoteId: target.remoteId,
    targetFingerprint: hash(JSON.stringify(target)), attemptId: randomUUID(),
    outcome: "UNKNOWN", claimedAt: new Date().toISOString() };
  const handle = await open(join(dir, `${stem(target, action)}.claim.json`), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(claim) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  return claim;
}

async function saveResult(root, target, action, result) {
  const handle = await open(resultPath(root, target, action), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(result) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function exactSaveButton(page, expectedUrl, action) {
  const privateButton = await privateSaveControl(page, expectedUrl);
  if (!privateButton) return null;
  if (action === "STOP") return privateButton;
  const publicButton = page.getByRole("dialog").locator("footer")
    .getByRole("button", { name: "公開する", exact: true });
  return await publicButton.count() === 1 && await publicButton.isEnabled() &&
    await publicButton.getAttribute("type") === "button" ? publicButton : null;
}

/** One normal-UI transition. A claim survives every uncertain click and forbids replay. */
export async function runVisibilityTransitionOnce({ root, profileDir,
  playwrightModulePath, action, target, listing = null }, {
    claim = claimVisibilityTransitionOnce,
    openSession = openVisibilityTransitionSession,
    readVisibility = readExactVisibilityFromList,
    readFields = readPinnedEditFields,
    observe = observeManualShopsMutation,
    chooseSaveButton = exactSaveButton,
    readStopProof = readVerifiedStop,
    writeResult = saveResult,
    withListingSend = withShopListingSend,
  } = {}) {
  if (![root, profileDir, playwrightModulePath].every(value =>
      typeof value === "string" && isAbsolute(value)) ||
      !["STOP", "RELIST"].includes(action) || !exactVisibilityTarget(target))
    throw Error("Invalid exact visibility transition inputs");
  const priorStop = action === "RELIST" ? await readStopProof(root, target) : null;
  if (action === "RELIST" && !priorStop) return { status: "PREFLIGHT_BLOCKED" };
  if (action === "STOP" && (listing?.status !== "ACTIVE" ||
      listing.externalListingId !== target.remoteId))
    return { status: "PREFLIGHT_BLOCKED" };
  let marker;
  try { marker = await claim(root, action, target); }
  catch (error) {
    if (error?.code === "EEXIST") return { status: "ALREADY_ATTEMPTED" };
    throw error;
  }
  const performTransition = async () => {
  const expectedEditUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  const beforeVisibility = action === "STOP" ? "PUBLIC" : "PRIVATE";
  const afterVisibility = action === "STOP" ? "PRIVATE" : "PUBLIC";
  let stage = "CLAIMED";
  let session = null;
  let observer = null;
  let postClickOrder = null;
  let mayHaveClicked = false;
  let verified = false;
  try {
    session = await openSession({ root, profileDir, playwrightModulePath,
      shopId: target.shopId });
    stage = "BEFORE_READ_UNCERTAIN";
    const before = await readVisibility(session.page, { shopId: target.shopId,
      remoteId: target.remoteId, title: target.title, visibility: beforeVisibility });
    const plan = planVisibilityTransition({ action, target, readback: before,
      listing, stopProof: priorStop });
    if (plan.kind !== "READY" || session.page.url() !== expectedEditUrl)
      throw Error("Exact before state unavailable");
    const fields = await readFields(session.page, expectedEditUrl, target);
    if (!fields || fields.title !== target.title) throw Error("Exact edit fields unavailable");
    observer = observe(session.page, expectedEditUrl, { shopsOnly: true });
    stage = "NEXT_CLICK_UNCERTAIN";
    const next = session.page.getByRole("button", { name: "公開設定に進む", exact: true });
    if (await next.count() !== 1 || !await next.isEnabled())
      throw Error("Next control unavailable");
    mayHaveClicked = true;
    await next.click({ timeout: 12000 });
    stage = "SAVE_CONTROL_UNCERTAIN";
    const fieldsAgain = await readFields(session.page, expectedEditUrl, target, false);
    if (!fieldsAgain || fieldsAgain.title !== target.title)
      throw Error("Fields changed before save");
    const button = await chooseSaveButton(session.page, expectedEditUrl, action);
    if (!button) throw Error("Observed visibility dialog changed");
    postClickOrder = observer.checkpoint();
    stage = "SAVE_CLICK_UNCERTAIN";
    await button.click({ timeout: 12000 });
    stage = "SAVE_RESPONSE_UNCERTAIN";
    const idle = await observer.waitForPostClickIdle(postClickOrder, 12000);
    const events = await observer.stop();
    observer = null;
    if (!idle || !exactVisibilityMutationAcknowledgement(events, action))
      throw Error("Exact update response unavailable");
    stage = "AFTER_READ_UNCERTAIN";
    const readPage = await session.context.newPage();
    try {
      const after = await readVisibility(readPage, { shopId: target.shopId,
        remoteId: target.remoteId, title: target.title, visibility: afterVisibility });
      verified = after.kind === "OBSERVED" && after.shopId === target.shopId &&
        after.remoteId === target.remoteId && after.title === target.title &&
        after.visibility === afterVisibility;
    } finally { await readPage.close().catch(() => {}); }
    if (!verified) throw Error("Exact after state unavailable");
    stage = "VERIFIED";
  } catch { /* The claim makes every unknown result permanently non-retryable. */ }
  finally {
    if (observer) {
      if (postClickOrder !== null)
        await observer.waitForPostClickIdle(postClickOrder, 12000).catch(() => false);
      await observer.stop().catch(() => {});
    }
  }
  const result = { schemaVersion: 1, action, shopId: target.shopId,
    inventoryId: target.inventoryId, remoteId: target.remoteId, title: target.title,
    targetFingerprint: marker.targetFingerprint, attemptId: marker.attemptId,
    outcome: verified ? `${action}_VERIFIED` : "UNKNOWN",
    observedVisibility: verified ? afterVisibility : null,
    diagnosticStage: stage, recordedAt: new Date().toISOString() };
  await writeResult(root, target, action, result);
  if (session && (!mayHaveClicked || verified))
    await session.context.close().catch(() => {});
  return { status: result.outcome, remoteId: target.remoteId,
    observedVisibility: result.observedVisibility,
    retainedSession: mayHaveClicked && !verified ? session : null };
  };
  if (action !== "RELIST") return performTransition();
  let transitionStarted = false;
  try {
    return await withListingSend(root, { shopId: target.shopId,
      inventoryId: target.inventoryId, operation: "RELIST",
      attemptId: marker.attemptId }, () => {
      transitionStarted = true;
      return performTransition();
    });
  } catch (error) {
    // The claim remains durable even when the interval/legacy lock cannot be acquired.
    if (transitionStarted) throw error;
    await writeResult(root, target, action, {
      schemaVersion: 1, action, shopId: target.shopId,
      inventoryId: target.inventoryId, remoteId: target.remoteId, title: target.title,
      targetFingerprint: marker.targetFingerprint, attemptId: marker.attemptId,
      outcome: "UNKNOWN", observedVisibility: null,
      diagnosticStage: "LISTING_INTERVAL_UNCERTAIN",
      recordedAt: new Date().toISOString(),
    });
    return { status: "UNKNOWN", remoteId: target.remoteId,
      observedVisibility: null, retainedSession: null };
  }
}
