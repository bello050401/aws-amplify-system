import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "./generalPrivateCreateDraftCollector.mjs";
import { searchGeneralPrivateCreateSaleSkuReadOnly } from
  "./generalPrivateCreateSaleSkuSearch.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ORIGIN = "https://mercari-shops.com";
const fixed = (status, diagnostic) => ({ status, diagnostic,
  allowFinalCreate: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();
const REMOTE_TITLE_MAX = 500;
const TITLE_PLACEHOLDERS = new Set(["", "-", "--", "---", "—", "…",
  "...", "商品名未設定", "読み込み中"]);
const DRAFT_FAILURES = new Set(["DRAFT_INPUT_UNVERIFIED",
  "DRAFT_LIST_UNVERIFIED", "DRAFT_LIST_CHANGED",
  "DRAFT_DETAIL_UNVERIFIED", "DRAFT_READ_UNAVAILABLE"]);

function authUrl(value) {
  try { const url = new URL(value);
    return url.origin === ORIGIN && url.pathname.startsWith("/signin/"); }
  catch { return false; }
}

function diagnoseSaleRow(row) {
  if (typeof row?.title !== "string" ||
      row.title.length > REMOTE_TITLE_MAX ||
      TITLE_PLACEHOLDERS.has(titleKey(row.title)))
    return "SALE_TITLE_LENGTH_UNVERIFIED";
  if (row.cellCount !== 10) return "SALE_CELL_COUNT_UNVERIFIED";
  if (row.dataActionCount !== 0) return "SALE_DATA_ACTION_UNVERIFIED";
  if (row.menuControlsVerified !== true)
    return "SALE_MENU_CONTROLS_UNVERIFIED";
  if (!["PUBLIC", "PRIVATE"].includes(row.visibility) ||
      !Number.isSafeInteger(row.quantity) || row.quantity < 0 ||
      !Number.isSafeInteger(row.priceYen) || row.priceYen < 1)
    return "SALE_LIST_VALUES_UNVERIFIED";
  if (typeof row.signature !== "string" || row.signature.length > 3000)
    return "SALE_SIGNATURE_LENGTH_UNVERIFIED";
  return "SALE_ROW_READY";
}

function diagnoseSale(snapshot, url) {
  if (authUrl(snapshot?.url) || authUrl(snapshot?.documentUrl))
    return "AUTH_SCREEN";
  if (snapshot?.url !== url || snapshot.documentUrl !== url)
    return "SALE_URL_UNEXPECTED";
  if (snapshot.statusChipExact !== true)
    return "SALE_STATUS_FILTER_UNVERIFIED";
  if (snapshot.visibilityChipExact !== true)
    return "SALE_VISIBILITY_FILTER_UNVERIFIED";
  if (snapshot.loading !== false) return "SALE_LOADING";
  if (snapshot.tableMatches !== 1 ||
      !Number.isSafeInteger(snapshot.tableIndex) || snapshot.tableIndex < 0 ||
      snapshot.headerCount !== 10 || snapshot.titleColumn !== 0)
    return "SALE_TABLE_UNVERIFIED";
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 50)
    return "SALE_ROW_COUNT_UNVERIFIED";
  const rowReason = snapshot.rows.map(diagnoseSaleRow)
    .find(reason => reason !== "SALE_ROW_READY");
  if (rowReason) return rowReason;
  if (snapshot.nextCount !== 1 || snapshot.prevCount !== 1)
    return "SALE_PAGINATION_CONTROLS_UNVERIFIED";
  if (typeof snapshot.nextDisabled !== "boolean" ||
      typeof snapshot.prevDisabled !== "boolean")
    return "SALE_PAGINATION_STATE_UNVERIFIED";
  return "SALE_READY";
}

export async function stableGeneralPrivateSaleList(ui, url, previousRows = null) {
  let previous = null;
  let stable = 0;
  let diagnostic = "SALE_UNSTABLE";
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await ui.saleSnapshot();
    const reason = diagnoseSale(current, url);
    if (reason === "SALE_READY" &&
        (previousRows === null || !same(current.rows, previousRows))) {
      diagnostic = "SALE_UNSTABLE";
      stable = previous && same(previous, current) ? stable + 1 : 1;
      previous = current;
      if (stable === 3) return { snapshot: current, diagnostic: null };
    } else {
      diagnostic = reason === "SALE_READY" ? "SALE_ROW_SET_UNCHANGED" : reason;
      previous = null; stable = 0;
    }
    await ui.wait(600);
  }
  return { snapshot: null, diagnostic };
}

export function generalPrivateSaleBrowserAdapter(page) {
  return {
    gotoSale: url => page.goto(url, { waitUntil: "domcontentloaded",
      timeout: 12000 }),
    saleSnapshot: async () => {
      const data = await page.locator("body").evaluate(() => {
        const text = node => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
        const observedHeaders = ["商品名", "", "公開設定", "価格", "在庫",
          "いいね!", "閲覧", "作成日時", "更新日時", ""];
        const matches = [...document.querySelectorAll("table")].map((table, index) => {
          const headers = [...table.querySelectorAll("thead th")].map(text);
          return { table, index, headers };
        }).filter(item => item.headers.length === observedHeaders.length &&
          item.headers.every((header, index) => header === observedHeaders[index]));
        const selected = matches.length === 1 ? matches[0] : null;
        const ACTIONABLE =
          'a, button, input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]';
        const menuKinds = [
          { prefix: "product-menu-button-", role: null, label: "メニュー" },
          { prefix: "copy-product-menu-item-", role: "menuitem", label: null },
          { prefix: "product-page-menu-item-", role: "menuitem", label: null },
        ];
        const rows = selected ? [...selected.table.querySelectorAll("tbody tr")].map(row => {
          const cells = [...row.querySelectorAll(":scope > td")];
          const visibilityText = text(cells[2]);
          const quantityText = text(cells[4]);
          const priceMatch = text(cells[3]).match(/^[￥¥]\s*([0-9][0-9,]*)/);
          const quantity = /^[0-9][0-9,]*$/.test(quantityText) ?
            Number(quantityText.replaceAll(",", "")) : null;
          const priceYen = priceMatch ?
            Number(priceMatch[1].replaceAll(",", "")) : null;
          const dataActionCount = cells.slice(0, -1).reduce((count, cell) =>
            count + Number(cell.matches(ACTIONABLE)) +
              cell.querySelectorAll(ACTIONABLE).length, 0);
          const menuActions = cells.length === 10 ?
            [...cells[9].querySelectorAll(ACTIONABLE)] : [];
          const suffixes = [];
          const menuControlsVerified = cells.length === 10 &&
            !cells[9].matches(ACTIONABLE) && menuActions.length === 3 &&
            menuKinds.every(kind => {
              const matches = menuActions.filter(action =>
                action.getAttribute("data-testid")?.startsWith(kind.prefix));
              if (matches.length !== 1 || matches[0].tagName !== "BUTTON")
                return false;
              const action = matches[0];
              const suffix = action.getAttribute("data-testid").slice(kind.prefix.length);
              if (!/^[A-Za-z0-9_-]{1,100}$/.test(suffix) ||
                  action.getAttribute("role") !== kind.role ||
                  (kind.label !== null &&
                    action.getAttribute("aria-label") !== kind.label) ||
                  (kind.prefix === "product-page-menu-item-" &&
                    (action.innerText !== "" ||
                      action.getAttribute("aria-label") !== null))) return false;
              suffixes.push(suffix);
              return true;
            }) && suffixes.every(suffix => suffix === suffixes[0]);
          return { title: text(cells[1]),
            remoteId: menuControlsVerified ? suffixes[0] : null,
            visibility: visibilityText === "公開" ? "PUBLIC" :
              visibilityText === "非公開" ? "PRIVATE" : null,
            quantity, priceYen,
            signature: JSON.stringify(cells.map(text)), cellCount: cells.length,
            dataActionCount, menuControlsVerified };
        }) : [];
        const next = [...document.querySelectorAll('[data-testid="pagination-next-button"]')];
        const prev = [...document.querySelectorAll('[data-testid="pagination-prev-button"]')];
        const disabled = control => control.disabled === true ||
          control.getAttribute("aria-disabled") === "true";
        const statusChips = [...document.querySelectorAll(
          'button[data-testid="product-status-chip"]')];
        const visibilityChips = [...document.querySelectorAll(
          'button[data-testid="visibility-chip"]')];
        const statusChipExact = statusChips.length === 1 &&
          text(statusChips[0]) === "ステータス: 出品中";
        const visibilityChipExact = visibilityChips.length === 1 &&
          text(visibilityChips[0]) === "公開状態: すべて";
        return { documentUrl: document.location.href,
          loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
          statusChipExact, visibilityChipExact, tableMatches: matches.length,
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
    clickSaleRow: (tableIndex, index) => page.locator("table").nth(tableIndex)
      .locator("tbody tr").nth(index).click({ timeout: 12000 }),
    saleDetail: async () => {
      const data = await page.locator("body").evaluate(() => {
        const names = document.querySelectorAll('input[name="name"]');
        const codes = document.querySelectorAll('input[name="variants.0.skuCode"]');
        const prices = document.querySelectorAll('input[name="price"]');
        const quantities = document.querySelectorAll(
          'input[name="variants.0.quantity"]');
        return { documentUrl: document.location.href,
          loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
          nameFieldCount: names.length, skuFieldCount: codes.length,
          priceFieldCount: prices.length, quantityFieldCount: quantities.length,
          title: names.length === 1 ? names[0].value : null,
          skuCode: codes.length === 1 ? codes[0].value : null,
          price: prices.length === 1 ? prices[0].value : null,
          quantity: quantities.length === 1 ? quantities[0].value : null };
      });
      return { ...data, url: page.url() };
    },
    wait: ms => page.waitForTimeout(ms),
  };
}

/** Advisory normal-UI read. No request routing, capture, form edits or save clicks. */
export async function scanGeneralPrivateCreateNormalUiReadOnly({ page, shopId,
  managementCode, title, expectedDraftRowCount = 12, adapter = null,
  collectDrafts = collectGeneralPrivateCreateDraftDetailsReadOnly,
  positiveControlPrefix = null,
  searchSaleSku = searchGeneralPrivateCreateSaleSkuReadOnly } = {}) {
  if (typeof shopId !== "string" || !ID.test(shopId) ||
      typeof managementCode !== "string" || !ID.test(managementCode) ||
      typeof title !== "string" || !title.trim() || title.length > 130 ||
      !Number.isSafeInteger(expectedDraftRowCount) ||
      expectedDraftRowCount < 1 || expectedDraftRowCount > 50 ||
      !adapter && !page || typeof collectDrafts !== "function" ||
      positiveControlPrefix !== null && typeof searchSaleSku !== "function")
    return fixed("REMOTE_SCAN_INCOMPLETE", "INPUT_UNVERIFIED");
  const ui = adapter ?? generalPrivateSaleBrowserAdapter(page);
  const saleUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=on_sale`;
  try {
    await ui.gotoSale(saleUrl);
    let previousRows = null;
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const settled = await stableGeneralPrivateSaleList(ui, saleUrl, previousRows);
      const current = settled.snapshot;
      if (!current) return fixed("REMOTE_SCAN_INCOMPLETE", settled.diagnostic);
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
    let drafts;
    try { drafts = await collectDrafts({ page, shopId,
      expectedRowCount: expectedDraftRowCount }); }
    catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_READ_UNAVAILABLE"); }
    let draftStatus;
    let draftRows;
    let draftAllowFinalCreate;
    try {
      draftStatus = drafts?.status;
      draftRows = drafts?.rows;
      draftAllowFinalCreate = drafts?.allowFinalCreate;
    } catch { return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_RESULT_UNVERIFIED"); }
    if (draftAllowFinalCreate !== false)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_RESULT_UNVERIFIED");
    if (draftStatus !== "DRAFT_DETAILS_DOM_OBSERVED")
      return fixed("REMOTE_SCAN_INCOMPLETE",
        DRAFT_FAILURES.has(draftStatus) && Array.isArray(draftRows) &&
          draftRows.length === 0 ? draftStatus : "DRAFT_RESULT_UNVERIFIED");
    if (!Array.isArray(draftRows) ||
        draftRows.length !== expectedDraftRowCount)
      return fixed("REMOTE_SCAN_INCOMPLETE", "DRAFT_RESULT_UNVERIFIED");
    if (draftRows.some(row => row?.skuCode &&
        row.skuCode.toUpperCase() === managementCode.toUpperCase()))
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "DRAFT_SKU_MATCH");
    if (draftRows.some(row => typeof row?.title === "string" &&
        row.title && titleKey(row.title) === titleKey(title)))
      return fixed("REMOTE_DUPLICATE_POSSIBLE", "DRAFT_TITLE_MATCH");
    if (positiveControlPrefix !== null) {
      let search;
      try { search = await searchSaleSku({ page, shopId, managementCode,
        positiveControlPrefix }); }
      catch { return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_READ_UNAVAILABLE"); }
      let diagnostic;
      let allowFinalCreate;
      try { diagnostic = search?.diagnostic;
        allowFinalCreate = search?.allowFinalCreate; }
      catch { return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_RESULT_UNVERIFIED"); }
      if (allowFinalCreate !== false)
        return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_RESULT_UNVERIFIED");
      if (diagnostic === "SALE_SKU_SEARCH_MATCH_POSSIBLE")
        return fixed("REMOTE_DUPLICATE_POSSIBLE", diagnostic);
      if (new Set(["SALE_SKU_SEARCH_NO_MATCH_OBSERVED",
        "SALE_SKU_SEARCH_INPUT_UNVERIFIED", "SALE_SKU_SEARCH_CONTROL_UNVERIFIED",
        "SALE_SKU_SEARCH_UNVERIFIED", "SALE_SKU_SEARCH_READ_UNAVAILABLE",
        "SALE_SKU_SEARCH_NAVIGATION_UNAVAILABLE",
        "SALE_SKU_SEARCH_CONTROL_LOOKUP_UNAVAILABLE",
        "SALE_SKU_SEARCH_TEXTBOX_ZERO", "SALE_SKU_SEARCH_TEXTBOX_MULTIPLE",
        "SALE_SKU_SEARCH_BUTTON_ZERO", "SALE_SKU_SEARCH_BUTTON_MULTIPLE",
        "SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE",
        "SALE_SKU_SEARCH_DOM_READ_UNAVAILABLE",
        "SALE_SKU_SEARCH_CONTROL_ROW_CLICK_UNAVAILABLE",
        "SALE_SKU_TARGET_CONTEXT_UNVERIFIED", "SALE_SKU_TARGET_LOADING",
        "SALE_SKU_TARGET_PRODUCT_ROWS_UNVERIFIED",
        "SALE_SKU_TARGET_PAGER_UNVERIFIED",
        "SALE_SKU_TARGET_EMPTY_ROW_COUNT_UNVERIFIED",
        "SALE_SKU_TARGET_EMPTY_SHAPE_UNVERIFIED",
        "SALE_SKU_TARGET_UNSTABLE"])
        .has(diagnostic))
        return fixed("REMOTE_SCAN_INCOMPLETE", diagnostic);
      return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_RESULT_UNVERIFIED");
    }
    // Without a controlled search, on-sale SKU identity remains unverified.
    return fixed("REMOTE_SCAN_INCOMPLETE", "SALE_SKU_UNVERIFIED");
  } catch { return fixed("REMOTE_SCAN_INCOMPLETE", "UI_READ_UNAVAILABLE"); }
}
