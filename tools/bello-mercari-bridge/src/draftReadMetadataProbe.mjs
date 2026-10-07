import { isAbsolute } from "node:path";
import { openDraftMetadataReadSession } from "./session.mjs";
import { observeDraftReadMetadata,
  isExplicitDraftReadQueryRequest } from "./draftReadMetadataObserver.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ORIGIN = "https://mercari-shops.com";
const TYPES = ["null", "array", "object", "string", "number", "boolean"];
const fixed = (status, closeStatus = "NOT_OPENED") => ({ status,
  observations: [], closeStatus, allowFinalCreate: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function exactDraftDetail(url, shopId) {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN &&
      parsed.pathname === `/seller/shops/${shopId}/products/create` &&
      [...parsed.searchParams.keys()].join() === "productDraftId" &&
      ID.test(parsed.searchParams.get("productDraftId") ?? "");
  } catch { return false; }
}

async function listSnapshot(page) {
  const data = await page.locator("body").evaluate(() => {
    const text = element => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    const matches = [...document.querySelectorAll("table")].map((table, index) => {
      const headers = [...table.querySelectorAll("thead th")].map(text);
      return { table, index, headers };
    }).filter(item => item.headers.length === 8 &&
      item.headers[0] === "商品名" && item.headers.includes("作成日時") &&
      item.headers.includes("更新日時"));
    const selected = matches.length === 1 ? matches[0] : null;
    const rows = selected ? [...selected.table.querySelectorAll("tbody tr")].map(row => {
      const cells = [...row.querySelectorAll(":scope > td")];
      return { cellCount: cells.length, signature: JSON.stringify(cells.map(text)),
        interactiveCount: row.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [contenteditable="true"]').length };
    }) : [];
    return { documentUrl: document.location.href, tableMatches: matches.length,
      tableIndex: selected?.index ?? -1, rows,
      loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      paginationControls: document.querySelectorAll(
        '[data-testid="pagination-next-button"], [data-testid="pagination-prev-button"]').length };
  });
  return { ...data, url: page.url() };
}

function validList(snapshot, listUrl, expectedRowCount) {
  return snapshot?.url === listUrl && snapshot.documentUrl === listUrl &&
    snapshot.tableMatches === 1 && Number.isSafeInteger(snapshot.tableIndex) &&
    snapshot.tableIndex >= 0 && snapshot.loading === false &&
    snapshot.paginationControls === 0 && Array.isArray(snapshot.rows) &&
    snapshot.rows.length === expectedRowCount &&
    snapshot.rows.every(row => row.cellCount === 8 &&
      row.interactiveCount === 0 && typeof row.signature === "string" &&
      row.signature.length <= 3000);
}

function safeObservation(value) {
  if (!value || !["DRAFT_LIST", "DRAFT_DETAIL"].includes(value.pageKind) ||
      value.operationClass !== "NAMED_QUERY" ||
      !Number.isInteger(value.httpStatus) || value.httpStatus < 100 ||
      value.httpStatus > 599) return null;
  const shape = value.responseShape;
  const responseType = typeof shape === "string" ? shape : shape?.type;
  if (responseType !== null && responseType !== undefined &&
      !TYPES.includes(responseType)) return null;
  const result = { pageKind: value.pageKind, operationClass: "NAMED_QUERY",
    httpStatus: value.httpStatus, responseType: responseType ?? null,
    hasErrors: typeof value.hasErrors === "boolean" ? value.hasErrors : null };
  if (responseType === "object" && Number.isSafeInteger(shape.fieldCount) &&
      shape.fieldCount >= 0 && shape.fieldCount <= 24 &&
      typeof shape.overLimit === "boolean" && shape.typeCounts &&
      TYPES.every(type => Number.isSafeInteger(shape.typeCounts[type]) &&
        shape.typeCounts[type] >= 0 && shape.typeCounts[type] <= 24)) {
    result.fieldCount = shape.fieldCount;
    result.overLimit = shape.overLimit;
    result.typeCounts = Object.fromEntries(TYPES.map(type =>
      [type, shape.typeCounts[type]]));
  }
  return result;
}

/** One explicit, metadata-only read of the observed draft list and one row. */
export async function probeDraftReadMetadataOnce({ root, profileDir,
  playwrightModulePath, shopId, confirmReadOnly = false,
  expectedRowCount = 12, rowIndex = 0,
  openSession = openDraftMetadataReadSession,
  observe = observeDraftReadMetadata } = {}) {
  if (confirmReadOnly !== true || !ID.test(shopId ?? "") ||
      ![root, profileDir, playwrightModulePath].every(path =>
        typeof path === "string" && isAbsolute(path)) ||
      !Number.isSafeInteger(expectedRowCount) || expectedRowCount < 1 ||
      expectedRowCount > 50 || !Number.isSafeInteger(rowIndex) ||
      rowIndex < 0 || rowIndex >= expectedRowCount)
    return fixed("INPUT_UNVERIFIED");
  const listUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=draft`;
  let session = null;
  let observer = null;
  let status = "READ_UNAVAILABLE";
  let metadata = null;
  let closeStatus = "NOT_OPENED";
  const readOnlyRoute = async route => {
    try {
      const request = route.request();
      if (["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
          isExplicitDraftReadQueryRequest(request)) await route.continue();
      else await route.abort();
    } catch { try { await route.abort(); } catch { /* Closing the page also stops routing. */ } }
  };
  try {
    session = await openSession({ root, profileDir, playwrightModulePath, shopId,
      requestGuard: readOnlyRoute });
    closeStatus = "CLOSE_UNVERIFIED";
    observer = observe(session.context, { page: session.page, shopId });
    await session.context.setOffline(false);
    await session.page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (session.page.url().startsWith(`${ORIGIN}/signin/`)) status = "AUTH_REQUIRED";
    else {
      const first = await listSnapshot(session.page);
      await session.page.waitForTimeout(600);
      const second = await listSnapshot(session.page);
      await session.page.waitForTimeout(600);
      const third = await listSnapshot(session.page);
      if (!validList(first, listUrl, expectedRowCount) ||
          !same(first, second) || !same(second, third))
        status = "DRAFT_LIST_UNVERIFIED";
      else {
        await session.page.locator("table").nth(first.tableIndex)
          .locator("tbody tr").nth(rowIndex).click({ timeout: 12000 });
        if (!exactDraftDetail(session.page.url(), shopId))
          status = "DRAFT_DETAIL_UNVERIFIED";
        else {
          await session.page.locator('input[name="variants.0.skuCode"]')
            .waitFor({ state: "visible", timeout: 12000 });
          await session.page.waitForTimeout(600);
          if (!exactDraftDetail(session.page.url(), shopId) ||
              await session.page.locator('input[name="name"]').count() !== 1 ||
              await session.page.locator('input[name="variants.0.skuCode"]').count() !== 1)
            status = "DRAFT_DETAIL_UNVERIFIED";
          else {
            await session.page.waitForTimeout(1000);
            status = "DRAFT_UI_READ_OBSERVED";
          }
        }
      }
    }
  } catch { status = "READ_UNAVAILABLE"; }
  finally {
    try { await session?.context.setOffline(true); }
    catch { status = "OFFLINE_RESTORE_UNVERIFIED"; }
    try { metadata = await observer?.stop(); }
    catch { status = "METADATA_UNVERIFIED"; }
    try { if (session) { await session.context.close(); closeStatus = "CLOSED"; } }
    catch { closeStatus = "CLOSE_UNVERIFIED"; }
  }
  const observations = Array.isArray(metadata?.observations) ?
    metadata.observations.slice(0, 24).map(safeObservation).filter(Boolean) : [];
  if (status === "DRAFT_UI_READ_OBSERVED" &&
      metadata?.status === "METADATA_TRUNCATED") status = "METADATA_TRUNCATED";
  if (status === "DRAFT_UI_READ_OBSERVED" && observations.length === 0)
    status = "NO_QUERY_METADATA";
  if (closeStatus === "CLOSE_UNVERIFIED") status = "BROWSER_CLOSE_UNVERIFIED";
  return { status, observations, closeStatus, allowFinalCreate: false };
}
