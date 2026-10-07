import { exactGeneralPrivateCreatePack, readGeneralPrivateCreate,
  readGeneralPrivateCreateClaim } from "./generalPrivateCreateJob.mjs";

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
        if (!sameKeys(row, ["remoteId", "title", "skuCode",
          "detailVerified"]) ||
            (row.remoteId !== null &&
              (typeof row.remoteId !== "string" || !ID.test(row.remoteId) ||
                allIds.has(row.remoteId))) ||
            (tabIndex === 0 && row.remoteId === null) ||
            typeof row.title !== "string" || row.title.length > 130 ||
            (row.skuCode !== null &&
              (typeof row.skuCode !== "string" ||
                !ID.test(row.skuCode))) ||
            (row.remoteId === null ? row.detailVerified !== false :
              row.detailVerified !== true))
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
  if (duplicate) return fixed("REMOTE_DUPLICATE_POSSIBLE", onSaleRows, draftRows);
  if (incomplete) return fixed("REMOTE_SCAN_INCOMPLETE", onSaleRows, draftRows);
  if (ambiguousDraft) return fixed("REMOTE_DRAFT_AMBIGUOUS", onSaleRows, draftRows);
  return fixed("NO_MATCH_IN_OBSERVED_UI", onSaleRows, draftRows);
}

/** Local UNKNOWN claims block even a later complete read-only list scan. */
export async function preflightGeneralPrivateCreateRemote({ root, inventoryId,
  captureReadOnlyScan = null }) {
  const { pack } = await readGeneralPrivateCreate(root, inventoryId);
  if (await readGeneralPrivateCreateClaim(root, inventoryId))
    return fixed("LOCAL_CLAIM_UNKNOWN_NO_RETRY");
  if (typeof captureReadOnlyScan !== "function")
    return fixed("REMOTE_SCAN_UNAVAILABLE");
  try {
    const scan = await captureReadOnlyScan({ shopId: pack.shopId,
      managementCode: pack.managementCode, title: pack.title });
    return inspectGeneralPrivateCreateRemoteScan(pack, scan);
  } catch { return fixed("REMOTE_SCAN_UNAVAILABLE"); }
}
