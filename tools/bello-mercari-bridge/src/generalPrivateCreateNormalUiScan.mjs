import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "./generalPrivateCreateDraftCollector.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ORIGIN = "https://mercari-shops.com";
const fixed = (status, diagnostic) => ({ status, diagnostic,
  allowFinalCreate: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();

function validSale(snapshot, url) {
  return snapshot?.url === url && snapshot.documentUrl === url &&
    snapshot.loading === false && snapshot.allVisibilitySelected === true &&
    snapshot.tableMatches === 1 &&
    Number.isSafeInteger(snapshot.tableIndex) && snapshot.tableIndex >= 0 &&
    Number.isSafeInteger(snapshot.headerCount) && snapshot.headerCount >= 2 &&
    Number.isSafeInteger(snapshot.titleColumn) && snapshot.titleColumn >= 0 &&
    snapshot.titleColumn < snapshot.headerCount &&
    snapshot.nextCount === 1 && snapshot.prevCount === 1 &&
    typeof snapshot.nextDisabled === "boolean" &&
    typeof snapshot.prevDisabled === "boolean" &&
    Array.isArray(snapshot.rows) && snapshot.rows.length <= 50 &&
    snapshot.rows.every(row => typeof row.title === "string" &&
      row.title.length <= 130 && row.cellCount === snapshot.headerCount &&
      row.interactiveCount === 0 && typeof row.signature === "string" &&
      row.signature.length <= 3000);
}

async function stableSale(ui, url, previousRows = null) {
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await ui.saleSnapshot();
    if (validSale(current, url) &&
        (previousRows === null || !same(current.rows, previousRows))) {
      stable = previous && same(previous, current) ? stable + 1 : 1;
      previous = current;
      if (stable === 3) return current;
    } else { previous = null; stable = 0; }
    await ui.wait(600);
  }
  return null;
}

function browserAdapter(page) {
  return {
    gotoSale: url => page.goto(url, { waitUntil: "domcontentloaded",
      timeout: 12000 }),
    saleSnapshot: async () => {
      const data = await page.locator("body").evaluate(() => {
        const text = node => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
        const matches = [...document.querySelectorAll("table")].map((table, index) => {
          const headers = [...table.querySelectorAll("thead th")].map(text);
          return { table, index, headers };
        }).filter(item => item.headers.filter(header => header === "商品名").length === 1);
        const selected = matches.length === 1 ? matches[0] : null;
        const rows = selected ? [...selected.table.querySelectorAll("tbody tr")].map(row => {
          const cells = [...row.querySelectorAll(":scope > td")];
          return { title: text(cells[selected.headers.indexOf("商品名")]),
            signature: JSON.stringify(cells.map(text)), cellCount: cells.length,
            interactiveCount: row.querySelectorAll(
              'a, button, input, select, textarea, [role="button"], [contenteditable="true"]').length };
        }) : [];
        const next = [...document.querySelectorAll('[data-testid="pagination-next-button"]')];
        const prev = [...document.querySelectorAll('[data-testid="pagination-prev-button"]')];
        const disabled = control => control.disabled === true ||
          control.getAttribute("aria-disabled") === "true";
        // The exact visibility-filter control has not been mapped in the UI.
        // A selected "すべて" elsewhere on the page is never evidence.
        const allSelected = false;
        return { documentUrl: document.location.href,
          loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
          allVisibilitySelected: allSelected, tableMatches: matches.length,
          tableIndex: selected?.index ?? -1,
          headerCount: selected?.headers.length ?? 0,
          titleColumn: selected?.headers.indexOf("商品名") ?? -1,
          rows, nextCount: next.length, prevCount: prev.length,
          nextDisabled: next.length === 1 ? disabled(next[0]) : null,
          prevDisabled: prev.length === 1 ? disabled(prev[0]) : null };
      });
      return { ...data, url: page.url() };
    },
    clickNext: () => page.locator('[data-testid="pagination-next-button"]')
      .click({ timeout: 12000 }),
    wait: ms => page.waitForTimeout(ms),
  };
}

/** Advisory normal-UI read. No request routing, capture, form edits or save clicks. */
export async function scanGeneralPrivateCreateNormalUiReadOnly({ page, shopId,
  managementCode, title, expectedDraftRowCount = 12, adapter = null,
  collectDrafts = collectGeneralPrivateCreateDraftDetailsReadOnly } = {}) {
  if (typeof shopId !== "string" || !ID.test(shopId) ||
      typeof managementCode !== "string" || !ID.test(managementCode) ||
      typeof title !== "string" || !title.trim() || title.length > 130 ||
      !Number.isSafeInteger(expectedDraftRowCount) ||
      expectedDraftRowCount < 1 || expectedDraftRowCount > 50 ||
      !adapter && !page || typeof collectDrafts !== "function")
    return fixed("REMOTE_SCAN_INCOMPLETE", "INPUT_UNVERIFIED");
  const ui = adapter ?? browserAdapter(page);
  const saleUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=on_sale`;
  try {
    await ui.gotoSale(saleUrl);
    let previousRows = null;
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const current = await stableSale(ui, saleUrl, previousRows);
      if (!current) return fixed("REMOTE_SCAN_INCOMPLETE",
        pageIndex === 0 ? "SALE_TABLE_UNVERIFIED" : "SALE_PAGINATION_UNVERIFIED");
      if (pageIndex === 0 && (current.prevDisabled !== true ||
          current.nextDisabled !== false) ||
          pageIndex > 0 && current.prevDisabled !== false)
        return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_PAGINATION_UNVERIFIED");
      if (current.rows.some(row => row.title &&
          titleKey(row.title) === titleKey(title)))
        return fixed("REMOTE_DUPLICATE_POSSIBLE", "SALE_TITLE_MATCH");
      if (current.nextDisabled) break;
      if (pageIndex === 49 || current.rows.length === 0)
        return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_PAGINATION_UNVERIFIED");
      previousRows = current.rows;
      await ui.clickNext();
    }
    const drafts = await collectDrafts({ page, shopId,
      expectedRowCount: expectedDraftRowCount });
    if (drafts?.status !== "DRAFT_DETAILS_DOM_OBSERVED" ||
        !Array.isArray(drafts.rows) ||
        drafts.rows.length !== expectedDraftRowCount ||
        drafts.allowFinalCreate !== false)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_UNVERIFIED");
    if (drafts.rows.some(row => row?.skuCode &&
        row.skuCode.toUpperCase() === managementCode.toUpperCase()))
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "DRAFT_SKU_MATCH");
    if (drafts.rows.some(row => typeof row?.title === "string" &&
        row.title && titleKey(row.title) === titleKey(title)))
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "DRAFT_TITLE_MATCH");
    // On-sale SKU identity has not been verified by the observed list contract.
    return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_UNVERIFIED");
  } catch { return fixed("REMOTE_SCAN_INCOMPLETE", "UI_READ_UNAVAILABLE"); }
}
