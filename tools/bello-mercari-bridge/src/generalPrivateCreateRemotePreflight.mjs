import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { exactGeneralPrivateCreatePack, readGeneralPrivateCreate,
  readGeneralPrivateCreateClaim } from "./generalPrivateCreateJob.mjs";
import { exactB005396ReviewedPack } from
  "./b005396ReviewedValues.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TABS = ["ON_SALE_ALL", "DRAFT_ALL"];
const fixed = (status, onSaleRows = 0, draftRows = 0) => ({
  status, onSaleRows, draftRows, allowFinalCreate: false,
});
const sameKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();
const KNOWN_EXISTING_ID = "2JVJtFhb6kB5JBGkDbi2nm";
const KNOWN_EXISTING_TITLE =
  "HUKLA KASTOR 2Pソファ / モダン 北欧 デザイナーズ ソファ 2人掛け フクラ カストール 片アームソファ";
const APPROVAL_BASIS = "USER_APPROVED_ONE_NEW_PRIVATE_TEST_B005396_PRICE_99999";
const EXCEPTION_KIND = "B005396_KNOWN_EXISTING_PRIVATE_TEST_EXCEPTION";
const packHash = pack => createHash("sha256")
  .update(JSON.stringify(pack)).digest("hex");

/** In-memory review of the observed seller lists. No result authorizes a send. */
export function inspectGeneralPrivateCreateRemoteScan(input, scan,
  now = Date.now()) {
  const pack = exactGeneralPrivateCreatePack(input);
  if (!pack || !Number.isFinite(now) ||
      !sameKeys(scan, ["shopId", "managementCode", "observedAt", "tabs"]) ||
      scan.shopId !== pack.shopId ||
      scan.managementCode !== pack.managementCode ||
      typeof scan.observedAt !== "string" ||
      !Number.isFinite(Date.parse(scan.observedAt)) ||
      Date.parse(scan.observedAt) > now ||
      now - Date.parse(scan.observedAt) > 120_000 ||
      !Array.isArray(scan.tabs) || scan.tabs.length !== 2 ||
      scan.tabs.some((tab, index) => tab?.kind !== TABS[index]))
    return fixed("REMOTE_SCAN_UNVERIFIED");

  const allIds = new Set();
  let onSaleRows = 0;
  let draftRows = 0;
  let incomplete = false;
  let ambiguousDraft = false;
  let duplicate = false;
  let lastOnSaleFirstId = null;
  for (const [tabIndex, tab] of scan.tabs.entries()) {
    const tabUrl = `https://mercari-shops.com/seller/shops/${pack.shopId}/products?tab=${
      tabIndex === 0 ? "on_sale" : "draft"}`;
    if (!sameKeys(tab, ["kind", "tabUrl", "allVisibilitySelected",
      "paginationKind", "pages"]) || tab.tabUrl !== tabUrl ||
        tab.allVisibilitySelected !== (tabIndex === 0 ? true : null) ||
        tab.paginationKind !== (tabIndex === 0 ? "PREV_NEXT" : "NO_CONTROLS") ||
        !Array.isArray(tab.pages) || tab.pages.length < 1 ||
        tab.pages.length > 50 || tabIndex === 1 && tab.pages.length !== 1)
      return fixed("REMOTE_SCAN_UNVERIFIED");
    let previousFirstId = null;
    for (const [pageIndex, page] of tab.pages.entries()) {
      if (!sameKeys(page, ["pageNumber", "bodyRowCount", "nextDisabled",
        "rows", "settled"]) || page.pageNumber !== pageIndex + 1 ||
          !Number.isSafeInteger(page.bodyRowCount) ||
          page.bodyRowCount < 0 || page.bodyRowCount > 50 ||
          !Array.isArray(page.rows) || page.rows.length !== page.bodyRowCount ||
          (tabIndex === 0 ? typeof page.nextDisabled !== "boolean" :
            page.nextDisabled !== null))
        return fixed("REMOTE_SCAN_UNVERIFIED");
      const firstId = page.rows[0]?.remoteId ?? null;
      const settled = page.settled;
      const expectedBefore = pageIndex > 0 ? previousFirstId :
        tabIndex === 1 ? lastOnSaleFirstId : null;
      const expectedTransition = pageIndex > 0 ? "NEXT_CLICK_ROW_CHANGED" :
        tabIndex === 1 ? "TAB_CHANGED_ROW_SET" : "TAB_NAVIGATION";
      if (!sameKeys(settled, ["transitionKind", "firstIdBefore",
        "firstIdAfter", "rowIdsOnSecondRead", "nextDisabledOnSecondRead",
        "delayMs"]) ||
          settled.transitionKind !== expectedTransition ||
          settled.firstIdBefore !== expectedBefore ||
          settled.firstIdAfter !== firstId ||
          ((pageIndex > 0 || tabIndex === 1) &&
            (firstId === expectedBefore || pageIndex > 0 && firstId === null)) ||
          !Array.isArray(settled.rowIdsOnSecondRead) ||
          settled.rowIdsOnSecondRead.length !== page.rows.length ||
          settled.rowIdsOnSecondRead.some((id, index) =>
            id !== (page.rows[index]?.remoteId ?? null)) ||
          settled.nextDisabledOnSecondRead !== page.nextDisabled ||
          !Number.isSafeInteger(settled.delayMs) || settled.delayMs < 500)
        return fixed("REMOTE_SCAN_UNVERIFIED");
      previousFirstId = firstId;
      if (tabIndex === 0 &&
          (pageIndex < tab.pages.length - 1 && page.nextDisabled ||
            pageIndex === tab.pages.length - 1 && !page.nextDisabled))
        incomplete = true;
      for (const row of page.rows) {
        if (!sameKeys(row, tabIndex === 0 ? ["remoteId", "title", "skuCode",
          "detailVerified", "visibility", "quantity", "priceYen"] :
          ["remoteId", "title", "skuCode", "detailVerified"]) ||
            (row.remoteId !== null &&
              (typeof row.remoteId !== "string" || !ID.test(row.remoteId) ||
                allIds.has(row.remoteId))) ||
            (tabIndex === 0 && row.remoteId === null) ||
            typeof row.title !== "string" || row.title.length > 130 ||
            (row.skuCode !== null &&
              (typeof row.skuCode !== "string" ||
                !ID.test(row.skuCode))) ||
            (row.remoteId === null ? row.detailVerified !== false :
              row.detailVerified !== true) ||
            (tabIndex === 0 &&
              (!["PUBLIC", "PRIVATE"].includes(row.visibility) ||
                !Number.isSafeInteger(row.quantity) || row.quantity < 0 ||
                !Number.isSafeInteger(row.priceYen) || row.priceYen < 1)))
          return fixed("REMOTE_SCAN_UNVERIFIED");
        if (row.remoteId !== null) allIds.add(row.remoteId);
        if (row.skuCode?.toUpperCase() === pack.managementCode.toUpperCase() ||
            row.title && titleKey(row.title) === titleKey(pack.title))
          duplicate = true;
        if (tabIndex === 1 && (row.remoteId === null ||
            !row.title.trim() || row.skuCode === null))
          ambiguousDraft = true;
      }
      if (tabIndex === 0) onSaleRows += page.bodyRowCount;
      else draftRows += page.bodyRowCount;
    }
    if (tabIndex === 0) lastOnSaleFirstId = previousFirstId;
  }
  if (incomplete) return fixed("REMOTE_SCAN_INCOMPLETE", onSaleRows, draftRows);
  if (ambiguousDraft) return fixed("REMOTE_DRAFT_AMBIGUOUS", onSaleRows, draftRows);
  if (duplicate) return fixed("REMOTE_DUPLICATE_POSSIBLE", onSaleRows, draftRows);
  return fixed("NO_MATCH_IN_OBSERVED_UI", onSaleRows, draftRows);
}

/** One known sold-out public title is permitted for one new private test only. */
export function inspectB005396KnownExistingPrivateTest(input, scan,
  now = Date.now()) {
  const pack = exactB005396ReviewedPack(input);
  const ordinary = inspectGeneralPrivateCreateRemoteScan(input, scan, now);
  if (!pack || pack.title !== KNOWN_EXISTING_TITLE ||
      ordinary.status !== "REMOTE_DUPLICATE_POSSIBLE" ||
      ordinary.draftRows !== 12) return ordinary;
  const rows = scan.tabs.flatMap((tab, tabIndex) => tab.pages.flatMap(page =>
    page.rows.map(row => ({ tabIndex, row }))));
  if (rows.some(({ row }) => row.skuCode?.toUpperCase() ===
      pack.managementCode.toUpperCase())) return ordinary;
  const titles = rows.filter(({ row }) => row.title &&
    titleKey(row.title) === titleKey(pack.title));
  if (titles.length !== 1) return ordinary;
  const [{ tabIndex, row }] = titles;
  if (tabIndex !== 0 || row.remoteId !== KNOWN_EXISTING_ID ||
      row.title !== KNOWN_EXISTING_TITLE || row.skuCode !== null ||
      row.detailVerified !== true || row.visibility !== "PUBLIC" ||
      row.quantity !== 0 || row.priceYen !== 89_800)
    return ordinary;
  const evidence = { schemaVersion: 1, kind: EXCEPTION_KIND,
    approvalBasis: APPROVAL_BASIS, shopId: pack.shopId,
    inventoryId: pack.inventoryId, managementCode: pack.managementCode,
    packFingerprint: packHash(pack), knownExistingRemoteId: row.remoteId,
    knownExistingTitle: row.title, knownExistingSkuCode: null,
    knownExistingVisibility: "PUBLIC", knownExistingQuantity: 0,
    knownExistingPriceYen: 89_800, onSaleRows: ordinary.onSaleRows,
    draftRows: ordinary.draftRows, observedAt: scan.observedAt,
    noOtherCodeOrTitleMatch: true, allowPublic: false };
  return { status: "B005396_PRIVATE_TEST_EXCEPTION",
    onSaleRows: ordinary.onSaleRows, draftRows: ordinary.draftRows,
    allowFinalCreate: false, evidence };
}

export function exactB005396KnownExistingEvidence(input, evidence,
  now = Date.now()) {
  const pack = exactB005396ReviewedPack(input);
  if (!pack || pack.title !== KNOWN_EXISTING_TITLE ||
      !sameKeys(evidence, ["schemaVersion", "kind", "approvalBasis",
        "shopId", "inventoryId", "managementCode", "packFingerprint",
        "knownExistingRemoteId", "knownExistingTitle", "knownExistingSkuCode",
        "knownExistingVisibility", "knownExistingQuantity",
        "knownExistingPriceYen", "onSaleRows", "draftRows", "observedAt",
        "noOtherCodeOrTitleMatch", "allowPublic"]) ||
      evidence.schemaVersion !== 1 || evidence.kind !== EXCEPTION_KIND ||
      evidence.approvalBasis !== APPROVAL_BASIS ||
      evidence.shopId !== pack.shopId ||
      evidence.inventoryId !== pack.inventoryId ||
      evidence.managementCode !== pack.managementCode ||
      evidence.packFingerprint !== packHash(pack) ||
      evidence.knownExistingRemoteId !== KNOWN_EXISTING_ID ||
      evidence.knownExistingTitle !== KNOWN_EXISTING_TITLE ||
      evidence.knownExistingSkuCode !== null ||
      evidence.knownExistingVisibility !== "PUBLIC" ||
      evidence.knownExistingQuantity !== 0 ||
      evidence.knownExistingPriceYen !== 89_800 ||
      !Number.isSafeInteger(evidence.onSaleRows) ||
      evidence.onSaleRows < 1 || evidence.draftRows !== 12 ||
      evidence.noOtherCodeOrTitleMatch !== true ||
      evidence.allowPublic !== false ||
      typeof evidence.observedAt !== "string" ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      Date.parse(evidence.observedAt) > now ||
      now - Date.parse(evidence.observedAt) > 120_000) return null;
  return evidence;
}

/** Durable local basis is written once before any create-page claim. */
export async function recordB005396KnownExistingEvidence(root, input,
  evidence) {
  if (typeof root !== "string" || !isAbsolute(root) ||
      !exactB005396KnownExistingEvidence(input, evidence))
    throw Error("B005396_KNOWN_EXISTING_EVIDENCE_UNVERIFIED");
  const dir = join(root, "general-private-create-once");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${input.inventoryId}.known-existing-private-test.json`);
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(evidence) + "\n", "utf8");
    await handle.sync(); }
  finally { await handle.close(); }
}

/** Local UNKNOWN claims block even a later complete read-only list scan. */
export async function preflightGeneralPrivateCreateRemote({ root, inventoryId,
  captureReadOnlyScan = null, allowKnownExistingPrivateTest = false }) {
  const { pack } = await readGeneralPrivateCreate(root, inventoryId);
  if (await readGeneralPrivateCreateClaim(root, inventoryId))
    return fixed("LOCAL_CLAIM_UNKNOWN_NO_RETRY");
  if (typeof captureReadOnlyScan !== "function")
    return fixed("REMOTE_SCAN_UNAVAILABLE");
  try {
    const scan = await captureReadOnlyScan({ shopId: pack.shopId,
      managementCode: pack.managementCode, title: pack.title });
    return allowKnownExistingPrivateTest === true ?
      inspectB005396KnownExistingPrivateTest(pack, scan) :
      inspectGeneralPrivateCreateRemoteScan(pack, scan);
  } catch { return fixed("REMOTE_SCAN_UNAVAILABLE"); }
}
