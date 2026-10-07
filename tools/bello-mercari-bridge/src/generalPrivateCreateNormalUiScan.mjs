import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "./generalPrivateCreateDraftCollector.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ORIGIN = "https://mercari-shops.com";
const fixed = (status, diagnostic) => ({ status, diagnostic,
  allowFinalCreate: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();

function authUrl(value) {
  try { const url = new URL(value);
    return url.origin === ORIGIN && url.pathname.startsWith("/signin/"); }
  catch { return false; }
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
  if (snapshot.rows.some(row => typeof row.title !== "string" ||
      row.title.length > 130 || row.cellCount !== 10 ||
      row.dataActionCount !== 0 || row.menuControlsVerified !== true ||
      typeof row.signature !== "string" ||
      row.signature.length > 3000)) return "SALE_ROW_SHAPE_UNVERIFIED";
  if (snapshot.nextCount !== 1 || snapshot.prevCount !== 1)
    return "SALE_PAGINATION_CONTROLS_UNVERIFIED";
  if (typeof snapshot.nextDisabled !== "boolean" ||
      typeof snapshot.prevDisabled !== "boolean")
    return "SALE_PAGINATION_STATE_UNVERIFIED";
  return "SALE_READY";
}

async function stableSale(ui, url, previousRows = null) {
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

function browserAdapter(page) {
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
      const settled = await stableSale(ui, saleUrl, previousRows);
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
