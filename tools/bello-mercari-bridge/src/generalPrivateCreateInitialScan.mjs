import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "./generalPrivateCreateDraftCollector.mjs";
import { generalPrivateSaleBrowserAdapter,
  stableGeneralPrivateSaleList } from "./generalPrivateCreateNormalUiScan.mjs";

const ORIGIN = "https://mercari-shops.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();

function exactSaleDetail(view, shopId, row) {
  try {
    const url = new URL(view?.url);
    return url.origin === ORIGIN && url.username === "" &&
      url.password === "" && url.search === "" && url.hash === "" &&
      url.pathname === `/seller/shops/${shopId}/products/${row.remoteId}/edit` &&
      view.documentUrl === view.url && view.loading === false &&
      view.nameFieldCount === 1 && view.skuFieldCount === 1 &&
      view.priceFieldCount === 1 && view.quantityFieldCount === 1 &&
      typeof view.title === "string" && view.title.length <= 130 &&
      titleKey(view.title) === titleKey(row.title) &&
      typeof view.skuCode === "string" &&
      (view.skuCode === "" || ID.test(view.skuCode)) &&
      typeof view.price === "string" && /^[0-9]+$/.test(view.price) &&
      Number(view.price) === row.priceYen &&
      typeof view.quantity === "string" && /^[0-9]+$/.test(view.quantity) &&
      Number(view.quantity) === row.quantity;
  } catch { return false; }
}

async function stableDetail(ui, shopId, row) {
  let prior = null;
  let reads = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await ui.saleDetail();
    if (exactSaleDetail(current, shopId, row)) {
      reads = prior && same(prior, current) ? reads + 1 : 1;
      prior = current;
      if (reads === 3) return current;
    } else { prior = null; reads = 0; }
    if (attempt < 11) await ui.wait(600);
  }
  return null;
}

async function returnToPage(ui, url, pageIndex, pages) {
  await ui.gotoSale(url);
  let previous = null;
  for (let index = 0; index <= pageIndex; index++) {
    const { snapshot } = await stableGeneralPrivateSaleList(ui, url, previous);
    if (!snapshot || !same(snapshot.rows, pages[index].listRows) ||
        snapshot.nextDisabled !== pages[index].nextDisabled)
      throw Error("SALE_LIST_CHANGED");
    if (index === pageIndex) return snapshot;
    previous = snapshot.rows;
    await ui.clickNext();
  }
}

/**
 * Captures the exact raw structure required by remotePreflight from normal
 * seller UI reads. Any uncertain row/detail/transition throws, so the caller
 * reports REMOTE_SCAN_UNAVAILABLE and cannot open the create form.
 */
export async function captureGeneralPrivateInitialScanReadOnly({ page, shopId,
  managementCode, title, expectedDraftRowCount = 12, adapter = null,
  collectDrafts = collectGeneralPrivateCreateDraftDetailsReadOnly } = {}) {
  if (!ID.test(shopId ?? "") || !ID.test(managementCode ?? "") ||
      typeof title !== "string" || !title.trim() || title.length > 130 ||
      !Number.isSafeInteger(expectedDraftRowCount) ||
      expectedDraftRowCount < 1 || expectedDraftRowCount > 50 ||
      !adapter && !page || typeof collectDrafts !== "function")
    throw Error("INITIAL_SCAN_INPUT_UNVERIFIED");
  const ui = adapter ?? generalPrivateSaleBrowserAdapter(page);
  const saleUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=on_sale`;
  const draftUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=draft`;
  await ui.gotoSale(saleUrl);
  const salePages = [];
  let previousRows = null;
  let priorFirstId = null;
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const { snapshot: first } = await stableGeneralPrivateSaleList(
      ui, saleUrl, previousRows);
    if (!first || pageIndex === 0 && first.prevDisabled !== true ||
        pageIndex > 0 && first.prevDisabled !== false ||
        first.rows.some(row => !ID.test(row.remoteId ?? "") ||
          typeof row.title !== "string" || row.title.length > 130))
      throw Error("SALE_PAGE_UNVERIFIED");
    await ui.wait(600);
    const second = await ui.saleSnapshot();
    if (!second || !same(second.rows, first.rows) ||
        second.nextDisabled !== first.nextDisabled ||
        second.url !== saleUrl || second.documentUrl !== saleUrl)
      throw Error("SALE_SECOND_READ_CHANGED");
    const firstId = first.rows[0]?.remoteId ?? null;
    if (pageIndex > 0 && (firstId === priorFirstId || firstId === null))
      throw Error("SALE_PAGE_TRANSITION_UNVERIFIED");
    salePages.push({ pageNumber: pageIndex + 1,
      bodyRowCount: first.rows.length, nextDisabled: first.nextDisabled,
      rows: [], listRows: first.rows, tableIndex: first.tableIndex,
      settled: { transitionKind: pageIndex === 0 ? "TAB_NAVIGATION" :
        "NEXT_CLICK_ROW_CHANGED", firstIdBefore: priorFirstId,
        firstIdAfter: firstId,
        rowIdsOnSecondRead: second.rows.map(row => row.remoteId),
        nextDisabledOnSecondRead: second.nextDisabled, delayMs: 600 } });
    priorFirstId = firstId;
    if (first.nextDisabled) break;
    if (pageIndex === 49 || first.rows.length === 0)
      throw Error("SALE_PAGINATION_UNVERIFIED");
    previousRows = first.rows;
    await ui.clickNext();
  }
  for (const [pageIndex, captured] of salePages.entries()) {
    for (const [rowIndex, row] of captured.listRows.entries()) {
      const returned = await returnToPage(ui, saleUrl, pageIndex, salePages);
      await ui.clickSaleRow(returned.tableIndex, rowIndex);
      const detail = await stableDetail(ui, shopId, row);
      if (!detail) throw Error("SALE_DETAIL_UNVERIFIED");
      captured.rows.push({ remoteId: row.remoteId, title: detail.title,
        skuCode: detail.skuCode || null, detailVerified: true,
        visibility: row.visibility, quantity: row.quantity,
        priceYen: row.priceYen });
    }
  }
  const drafts = await collectDrafts({ page, shopId,
    expectedRowCount: expectedDraftRowCount });
  if (drafts?.status !== "DRAFT_DETAILS_DOM_OBSERVED" ||
      drafts.allowFinalCreate !== false ||
      drafts.rows?.length !== expectedDraftRowCount)
    throw Error("DRAFT_DETAILS_UNVERIFIED");
  await ui.wait(600);
  const secondDrafts = await collectDrafts({ page, shopId,
    expectedRowCount: expectedDraftRowCount });
  if (secondDrafts?.status !== "DRAFT_DETAILS_DOM_OBSERVED" ||
      secondDrafts.allowFinalCreate !== false ||
      !same(secondDrafts.rows, drafts.rows))
    throw Error("DRAFT_SECOND_READ_CHANGED");
  const draftRows = drafts.rows.map(row => {
    if (!ID.test(row?.draftId ?? "") ||
        typeof row.title !== "string" || !row.title.trim() ||
        !ID.test(row.skuCode ?? ""))
      throw Error("DRAFT_DETAIL_AMBIGUOUS");
    return { remoteId: row.draftId, title: row.title,
      skuCode: row.skuCode, detailVerified: true };
  });
  // The long detail walk must end with the original on-sale page sets intact.
  for (const pageIndex of salePages.keys())
    await returnToPage(ui, saleUrl, pageIndex, salePages);
  const rawPages = salePages.map(({ listRows, tableIndex, ...raw }) => raw);
  return { shopId, managementCode, observedAt: new Date().toISOString(),
    tabs: [
      { kind: "ON_SALE_ALL", tabUrl: saleUrl, allVisibilitySelected: true,
        paginationKind: "PREV_NEXT", pages: rawPages },
      { kind: "DRAFT_ALL", tabUrl: draftUrl, allVisibilitySelected: null,
        paginationKind: "NO_CONTROLS", pages: [{ pageNumber: 1,
          bodyRowCount: draftRows.length, nextDisabled: null,
          rows: draftRows,
          settled: { transitionKind: "TAB_CHANGED_ROW_SET",
            firstIdBefore: priorFirstId,
            firstIdAfter: draftRows[0]?.remoteId ?? null,
            rowIdsOnSecondRead: secondDrafts.rows.map(row => row.draftId),
            nextDisabledOnSecondRead: null, delayMs: 600 } }] },
    ] };
}
