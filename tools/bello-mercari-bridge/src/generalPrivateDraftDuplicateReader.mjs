import { searchGeneralPrivateCreateSaleSkuReadOnly } from
  "./generalPrivateCreateSaleSkuSearch.mjs";
import { collectGeneralPrivateCreateDraftDetailsReadOnly,
  readGeneralPrivateDraftListDom } from
  "./generalPrivateCreateDraftCollector.mjs";

const ORIGIN = "https://mercari-shops.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const READ_LIMIT = 12;
const WAIT_MS = 600;
const fixed = (status, diagnostic) => ({ status, diagnostic,
  complete: false, allowFinalCreate: false });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();

function authUrl(raw) {
  try { const url = new URL(raw);
    return url.origin === ORIGIN &&
      (url.pathname === "/signin" || url.pathname.startsWith("/signin/")); }
  catch { return false; }
}

function exactDraftList(view, listUrl) {
  return view?.url === listUrl && view.documentUrl === listUrl &&
    view.loading === false && view.paginationControls === 0 &&
    view.tableMatches === 1 && Number.isSafeInteger(view.tableIndex) &&
    view.tableIndex >= 0 && view.headerCount === 10 &&
    view.titleColumn === 0 && Array.isArray(view.rows) &&
    view.rows.length <= 50 && view.rows.every(row =>
      row?.cellCount === 10 && row.interactiveCount === 0 &&
      typeof row.title === "string" && row.title.length <= 130 &&
      typeof row.signature === "string" && row.signature.length <= 3000);
}

/** Stable zero is distinct from an unverified/loading/changed draft table. */
export async function readStableGeneralPrivateDraftCount({ page, shopId,
  readList = readGeneralPrivateDraftListDom,
  wait = ms => page.waitForTimeout(ms) }) {
  if (!page || !ID.test(shopId ?? "") || typeof readList !== "function" ||
      typeof wait !== "function") return fixed("REMOTE_SCAN_INCOMPLETE",
    "DRAFT_COUNT_INPUT_UNVERIFIED");
  const listUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=draft`;
  try { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 12000 }); }
  catch { return fixed("REMOTE_SCAN_INCOMPLETE",
    authUrl(page.url()) ? "AUTH_REQUIRED" : "DRAFT_LIST_NAVIGATION_UNAVAILABLE"); }
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < READ_LIMIT; attempt++) {
    let view;
    try { view = await readList(page); }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_READ_UNAVAILABLE"); }
    if (authUrl(page.url()) || authUrl(view?.url) ||
        authUrl(view?.documentUrl))
      return fixed("REMOTE_SCAN_INCOMPLETE", "AUTH_REQUIRED");
    if (exactDraftList(view, listUrl)) {
      stable = previous && same(previous, view) ? stable + 1 : 1;
      previous = view;
      if (stable === 3) return { status: "DRAFT_COUNT_OBSERVED",
        count: view.rows.length, allowFinalCreate: false };
    } else { previous = null; stable = 0; }
    if (attempt < READ_LIMIT - 1) {
      try { await wait(WAIT_MS); }
      catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_READ_UNAVAILABLE"); }
    }
  }
  return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_UNVERIFIED");
}

/**
 * Seller UI only: positive-control SKU search, exact-code zero search, then a
 * complete double-read of every draft. No result is public-create permission.
 */
export async function captureB005396PrivateDraftDuplicateProof({ context,
  shopId, managementCode, ownDraftId, title,
  positiveControlPrefix = "B00" }, {
    searchSaleSku = searchGeneralPrivateCreateSaleSkuReadOnly,
    readDraftCount = readStableGeneralPrivateDraftCount,
    collectDrafts = collectGeneralPrivateCreateDraftDetailsReadOnly,
  } = {}) {
  if (!context || typeof context.newPage !== "function" ||
      !ID.test(shopId ?? "") || !ID.test(managementCode ?? "") ||
      !ID.test(ownDraftId ?? "") || typeof title !== "string" ||
      !title.trim() || title.length > 130 ||
      typeof positiveControlPrefix !== "string" ||
      !/^[A-Za-z0-9_-]{2,20}$/.test(positiveControlPrefix) ||
      managementCode.startsWith(positiveControlPrefix))
    return fixed("REMOTE_SCAN_INCOMPLETE", "DUPLICATE_INPUT_UNVERIFIED");
  let page;
  try { page = await context.newPage(); }
  catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DUPLICATE_PAGE_UNAVAILABLE"); }
  try {
    let sale;
    try { sale = await searchSaleSku({ page, shopId, managementCode,
      positiveControlPrefix }); }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_UNVERIFIED"); }
    let saleDiagnostic, saleAllow;
    try { saleDiagnostic = sale?.diagnostic;
      saleAllow = sale?.allowFinalCreate; }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_UNVERIFIED"); }
    if (authUrl(page.url()))
      return fixed("REMOTE_SCAN_INCOMPLETE", "AUTH_REQUIRED");
    if (saleAllow !== false)
      return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_UNVERIFIED");
    if (saleDiagnostic === "SALE_SKU_SEARCH_MATCH_POSSIBLE")
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "SALE_SKU_MATCH_POSSIBLE");
    if (saleDiagnostic !== "SALE_SKU_SEARCH_NO_MATCH_OBSERVED")
      return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_UNVERIFIED");

    let count;
    try { count = await readDraftCount({ page, shopId }); }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_UNVERIFIED"); }
    let countStatus, countValue, countAllow, countDiagnostic;
    try { countStatus = count?.status; countValue = count?.count;
      countAllow = count?.allowFinalCreate;
      countDiagnostic = count?.diagnostic; }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_UNVERIFIED"); }
    if (authUrl(page.url()) || countDiagnostic === "AUTH_REQUIRED")
      return fixed("REMOTE_SCAN_INCOMPLETE", "AUTH_REQUIRED");
    if (countStatus !== "DRAFT_COUNT_OBSERVED" || countAllow !== false ||
        !Number.isSafeInteger(countValue) || countValue < 0 || countValue > 50)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_LIST_UNVERIFIED");
    if (countValue === 0)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_ZERO_ROWS_OBSERVED");

    let draftResult;
    try { draftResult = await collectDrafts({ page, shopId,
      expectedRowCount: countValue }); }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_DETAILS_UNVERIFIED"); }
    let draftStatus, draftRows, draftAllow;
    try { draftStatus = draftResult?.status; draftRows = draftResult?.rows;
      draftAllow = draftResult?.allowFinalCreate; }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_DETAILS_UNVERIFIED"); }
    if (authUrl(page.url()))
      return fixed("REMOTE_SCAN_INCOMPLETE", "AUTH_REQUIRED");
    if (draftStatus !== "DRAFT_DETAILS_DOM_OBSERVED" || draftAllow !== false ||
        !Array.isArray(draftRows) || draftRows.length !== countValue)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_DETAILS_UNVERIFIED");
    const rows = [];
    const seen = new Set();
    try {
      for (const row of draftRows) {
        const id = row?.draftId;
        const rowTitle = row?.title;
        const code = row?.skuCode;
        if (!ID.test(id ?? "") || seen.has(id) ||
            typeof rowTitle !== "string" || rowTitle.length > 130 ||
            (code !== null && (typeof code !== "string" ||
              !ID.test(code))))
          return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_DETAILS_UNVERIFIED");
        seen.add(id);
        rows.push({ id, title: rowTitle, code });
      }
    } catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_DETAILS_UNVERIFIED"); }
    const expectedTitle = titleKey(title);
    if (rows.some(row => row.id !== ownDraftId &&
        (row.code?.toUpperCase() === managementCode.toUpperCase() ||
          row.title && titleKey(row.title) === expectedTitle)))
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "DRAFT_MATCH_POSSIBLE");
    const own = rows.filter(row => row.id === ownDraftId);
    if (own.length !== 1 || own[0].code?.toUpperCase() !==
        managementCode.toUpperCase() || titleKey(own[0].title) !== expectedTitle)
      return fixed("REMOTE_SCAN_INCOMPLETE", "OWN_DRAFT_UNVERIFIED");
    if (rows.some(row => row.id !== ownDraftId &&
        (row.code === null || !row.title.trim())))
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_IDENTITY_UNVERIFIED");
    return { status: "NO_OTHER_MATCH_OBSERVED", complete: true,
      allowFinalCreate: false, shopId, managementCode, ownDraftId,
      observedAt: new Date().toISOString() };
  } finally { try { await page.close(); } catch { /* read-only page cleanup */ } }
}

/** Explicit callback adapter for the save pathway; never installed by default. */
export function bindB005396PrivateDraftDuplicateReader(context, deps) {
  return target => captureB005396PrivateDraftDuplicateProof({
    ...target, context }, deps);
}
