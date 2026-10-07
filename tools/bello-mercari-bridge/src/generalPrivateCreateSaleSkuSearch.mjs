const ORIGIN = "https://mercari-shops.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PREFIX = /^[A-Za-z0-9_-]{2,20}$/;
const SEARCH_LABEL = "商品管理コード（前方一致）、商品名検索";
const HEADERS = ["商品名", "", "公開設定", "価格", "在庫", "いいね!",
  "閲覧", "作成日時", "更新日時", ""];
const EMPTY_TEXT = "現在、登録している商品はありません";
const READ_LIMIT = 12;
const WAIT_MS = 600;
const TIMEOUT = 12_000;
const fixed = diagnostic => ({ diagnostic, allowFinalCreate: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function searchUrl(shopId, query) {
  const url = new URL(`${ORIGIN}/seller/shops/${shopId}/products?tab=on_sale`);
  url.searchParams.set("keyword", query);
  return url.href;
}

function validSearch(snapshot, url, query, kind) {
  if (snapshot?.url !== url || snapshot.documentUrl !== url ||
      snapshot.query !== query || snapshot.queryCount !== 1 ||
      snapshot.statusChipExact !== true ||
      snapshot.visibilityChipExact !== true || snapshot.loading !== false ||
      snapshot.tableMatches !== 1 ||
      !Number.isSafeInteger(snapshot.tableIndex) || snapshot.tableIndex < 0 ||
      snapshot.headerCount !== 10 ||
      snapshot.titleColumn !== 0 || !Array.isArray(snapshot.rows) ||
      snapshot.rows.length > 50 || snapshot.rows.some(row =>
        row.cellCount !== 10 || row.dataActionCount !== 0 ||
        row.menuControlsVerified !== true ||
        typeof row.signature !== "string" || row.signature.length > 3000))
    return false;
  if (kind === "positive") return snapshot.rows.length > 0 &&
    snapshot.emptyCount === 0 && snapshot.nonProductRowCount === 0 &&
    (snapshot.nextCount === 0 && snapshot.prevCount === 0 ||
      snapshot.nextCount === 1 && snapshot.prevCount === 1 &&
      snapshot.prevDisabled === true);
  return snapshot.rows.length === 0 && snapshot.emptyCount === 1 &&
    snapshot.emptyShapeExact === true && snapshot.nonProductRowCount === 2 &&
    snapshot.nextCount === 0 &&
    snapshot.prevCount === 0;
}

async function stableSearch(ui, url, query, kind) {
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < READ_LIMIT; attempt++) {
    const current = await ui.searchSnapshot();
    if (kind === "empty" && validSearch(current, url, query, "positive"))
      return { matchPossible: true };
    if (validSearch(current, url, query, kind)) {
      stable = previous && same(previous, current) ? stable + 1 : 1;
      previous = current;
      if (stable === 3) return current;
    } else { previous = null; stable = 0; }
    if (attempt < READ_LIMIT - 1) await ui.wait(WAIT_MS);
  }
  return null;
}

function validControlDetail(view, shopId, prefix) {
  try {
    const parsed = new URL(view?.url);
    const parts = parsed.pathname.split("/");
    return parsed.origin === ORIGIN && parsed.search === "" &&
      parsed.hash === "" && parts.length === 7 &&
      parts[1] === "seller" && parts[2] === "shops" &&
      parts[3] === shopId && parts[4] === "products" &&
      ID.test(parts[5]) && parts[6] === "edit" &&
      view.documentUrl === view.url && view.loading === false &&
      view.skuFieldCount === 1 && typeof view.skuCode === "string" &&
      view.skuCode.startsWith(prefix) && view.skuCode.length <= 100;
  } catch { return false; }
}

async function stableControlDetail(ui, shopId, prefix) {
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < READ_LIMIT; attempt++) {
    const current = await ui.controlDetail();
    if (validControlDetail(current, shopId, prefix)) {
      stable = previous && same(previous, current) ? stable + 1 : 1;
      previous = current;
      if (stable === 3) return true;
    } else { previous = null; stable = 0; }
    if (attempt < READ_LIMIT - 1) await ui.wait(WAIT_MS);
  }
  return false;
}

function browserAdapter(page) {
  return {
    goto: url => page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT }),
    search: async query => {
      const textbox = page.getByRole("textbox", { name: SEARCH_LABEL });
      // Match the observed working UI action; count still requires one control.
      const button = page.getByRole("button", { name: "search" });
      if (await textbox.count() !== 1 || await button.count() !== 1)
        throw Error("Search controls unavailable");
      await textbox.fill(query, { timeout: TIMEOUT });
      await button.click({ timeout: TIMEOUT });
    },
    searchSnapshot: async () => {
      const textbox = page.getByRole("textbox", { name: SEARCH_LABEL });
      const queryCount = await textbox.count();
      const query = queryCount === 1 ?
        await textbox.evaluate(element => element.value, undefined,
          { timeout: TIMEOUT }) : null;
      const data = await page.locator("body").evaluate((_body, { headers, emptyText }) => {
        const text = node => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
        const matches = [...document.querySelectorAll("table")].map((table, index) =>
          ({ table, index, headers: [...table.querySelectorAll("thead th")].map(text) }))
          .filter(item => item.headers.length === headers.length &&
            item.headers.every((value, index) => value === headers[index]));
        const table = matches.length === 1 ? matches[0].table : null;
        const ACTIONABLE =
          'a, button, input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]';
        const menuKinds = ["product-menu-button-", "copy-product-menu-item-",
          "product-page-menu-item-"];
        const allRows = table ? [...table.querySelectorAll("tbody tr")] : [];
        const rows = allRows
          .filter(row => row.querySelectorAll(":scope > td").length === 10)
          .map(row => {
            const cells = [...row.querySelectorAll(":scope > td")];
            const menu = [...cells[9].querySelectorAll(ACTIONABLE)];
            const suffixes = menuKinds.map(prefix => {
              const found = menu.filter(action =>
                action.getAttribute("data-testid")?.startsWith(prefix));
              if (found.length !== 1 || found[0].tagName !== "BUTTON") return null;
              return found[0].getAttribute("data-testid").slice(prefix.length);
            });
            return { cellCount: cells.length,
              signature: JSON.stringify(cells.map(text)),
              dataActionCount: cells.slice(0, -1).reduce((count, cell) =>
                count + Number(cell.matches(ACTIONABLE)) +
                  cell.querySelectorAll(ACTIONABLE).length, 0),
              menuControlsVerified: menu.length === 3 &&
                suffixes.every(suffix => suffix && /^[A-Za-z0-9_-]{1,100}$/.test(suffix) &&
                  suffix === suffixes[0]) };
          });
        const next = document.querySelectorAll('[data-testid="pagination-next-button"]');
        const prev = document.querySelectorAll('[data-testid="pagination-prev-button"]');
        const status = document.querySelectorAll('button[data-testid="product-status-chip"]');
        const visibility = document.querySelectorAll('button[data-testid="visibility-chip"]');
        const emptyCount = allRows
          .filter(row => text(row) === emptyText &&
            row.querySelectorAll(":scope > td").length !== 10).length;
        const emptyShapeExact = allRows.length === 2 &&
          allRows.every(row => row.querySelectorAll(":scope > td").length === 1) &&
          text(allRows[0]) === "" && text(allRows[1]) === emptyText;
        return { documentUrl: document.location.href,
          loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
          statusChipExact: status.length === 1 && text(status[0]) === "ステータス: 出品中",
          visibilityChipExact: visibility.length === 1 &&
            text(visibility[0]) === "公開状態: すべて",
          tableMatches: matches.length, tableIndex: matches.length === 1 ? matches[0].index : -1,
          headerCount: table ? headers.length : 0,
          titleColumn: table ? 0 : -1, rows, emptyCount, emptyShapeExact,
          nonProductRowCount: allRows.length - rows.length,
          nextCount: next.length, prevCount: prev.length,
          prevDisabled: prev.length === 1 ?
            prev[0].disabled === true || prev[0].getAttribute("aria-disabled") === "true" : null };
      }, { headers: HEADERS, emptyText: EMPTY_TEXT }, { timeout: TIMEOUT });
      return { ...data, queryCount, query, url: page.url() };
    },
    clickControlRow: tableIndex => page.locator("table").nth(tableIndex)
      .locator("tbody tr").first().click({ timeout: TIMEOUT }),
    controlDetail: async () => {
      const data = await page.locator("body").evaluate(() => {
        const codes = document.querySelectorAll('input[name="variants.0.skuCode"]');
        return { documentUrl: document.location.href,
          loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
          skuFieldCount: codes.length,
          skuCode: codes.length === 1 ? codes[0].value : null };
      }, undefined, { timeout: TIMEOUT });
      return { ...data, url: page.url() };
    },
    wait: ms => page.waitForTimeout(ms),
  };
}

/** Search controls are read only. A negative result is advisory, never CREATE permission. */
export async function searchGeneralPrivateCreateSaleSkuReadOnly({ page, shopId,
  managementCode, positiveControlPrefix, adapter = null } = {}) {
  if (typeof shopId !== "string" || !ID.test(shopId) ||
      typeof managementCode !== "string" || !ID.test(managementCode) ||
      typeof positiveControlPrefix !== "string" ||
      !PREFIX.test(positiveControlPrefix) ||
      managementCode.startsWith(positiveControlPrefix) || !adapter && !page)
    return fixed("SALE_SKU_SEARCH_INPUT_UNVERIFIED");
  const ui = adapter ?? browserAdapter(page);
  const baseUrl = `${ORIGIN}/seller/shops/${shopId}/products?tab=on_sale`;
  const controlUrl = searchUrl(shopId, positiveControlPrefix);
  const exactUrl = searchUrl(shopId, managementCode);
  try {
    await ui.goto(baseUrl);
    await ui.search(positiveControlPrefix);
    const control = await stableSearch(ui, controlUrl,
      positiveControlPrefix, "positive");
    if (!control) return fixed("SALE_SKU_SEARCH_CONTROL_UNVERIFIED");
    await ui.clickControlRow(control.tableIndex);
    if (!await stableControlDetail(ui, shopId, positiveControlPrefix))
      return fixed("SALE_SKU_SEARCH_CONTROL_UNVERIFIED");
    for (let pass = 0; pass < 2; pass++) {
      await ui.goto(baseUrl);
      await ui.search(managementCode);
      const exact = await stableSearch(ui, exactUrl, managementCode, "empty");
      if (exact?.matchPossible === true)
        return fixed("SALE_SKU_SEARCH_MATCH_POSSIBLE");
      if (!exact) {
        // An unstable screen cannot establish a negative search result.
        const observed = await ui.searchSnapshot();
        if (validSearch(observed, exactUrl, managementCode, "positive"))
          return fixed("SALE_SKU_SEARCH_MATCH_POSSIBLE");
        return fixed("SALE_SKU_SEARCH_UNVERIFIED");
      }
    }
    return fixed("SALE_SKU_SEARCH_NO_MATCH_OBSERVED");
  } catch { return fixed("SALE_SKU_SEARCH_READ_UNAVAILABLE"); }
}
