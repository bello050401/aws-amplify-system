const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHOP_ORIGIN = "https://mercari-shops.com";
const fixed = status => ({ status, rows: [], allowFinalCreate: false });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clean = value => value.replace(/\s+/g, " ").trim();
const LIST_READ_LIMIT = 12;
const LIST_STABLE_READS = 3;
const LIST_WAIT_MS = 600;
const UI_OPERATION_TIMEOUT_MS = 12_000;

function exactDraftId(url, shopId) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== SHOP_ORIGIN ||
        parsed.pathname !== `/seller/shops/${shopId}/products/create` ||
        [...parsed.searchParams.keys()].join() !== "productDraftId") return null;
    const id = parsed.searchParams.get("productDraftId");
    return id && ID.test(id) ? id : null;
  } catch { return null; }
}

function validList(snapshot, listUrl, expectedRowCount) {
  return snapshot?.url === listUrl && snapshot.documentUrl === listUrl &&
    snapshot.loading === false && snapshot.paginationControls === 0 &&
    Number.isSafeInteger(snapshot.tableIndex) && snapshot.tableIndex >= 0 &&
    snapshot.headerCount === 10 && snapshot.titleColumn === 0 &&
    Array.isArray(snapshot.rows) && snapshot.rows.length === expectedRowCount &&
    snapshot.rows.every(row => row.interactiveCount === 0 &&
      typeof row.title === "string" &&
      row.title.length <= 130 && typeof row.signature === "string" &&
      row.signature.length <= 3000);
}

function strictList(snapshot, listUrl, expectedRowCount) {
  return validList(snapshot, listUrl, expectedRowCount) &&
    snapshot.tableMatches === 1 &&
    snapshot.rows.every(row => row.cellCount === 10);
}

async function stableList(ui, listUrl, expectedRowCount, reference = null) {
  let previous = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < LIST_READ_LIMIT; attempt++) {
    const current = await ui.list();
    if (strictList(current, listUrl, expectedRowCount) &&
        (reference === null || same(current, reference))) {
      stableReads = previous && same(previous, current) ? stableReads + 1 : 1;
      previous = current;
      if (stableReads === LIST_STABLE_READS) return current;
    } else {
      previous = null;
      stableReads = 0;
    }
    if (attempt < LIST_READ_LIMIT - 1) {
      await ui.wait(LIST_WAIT_MS);
    }
  }
  return null;
}

function validDetail(snapshot, shopId) {
  const id = exactDraftId(snapshot?.url, shopId);
  return id && exactDraftId(snapshot.documentUrl, shopId) === id &&
    snapshot.loading === false && snapshot.nameFieldCount === 1 &&
    snapshot.skuFieldCount === 1 && typeof snapshot.title === "string" &&
    snapshot.title.length <= 130 && typeof snapshot.skuCode === "string" &&
    snapshot.skuCode.length <= 100 &&
    (!snapshot.skuCode || ID.test(snapshot.skuCode)) ? id : null;
}

/** DOM-only observation of the exact draft table. No form field is changed. */
async function readListDom(page) {
  const data = await page.locator("body").evaluate(() => {
    const text = element => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    const observedHeaders = ["商品名", "", "公開設定", "価格", "在庫",
      "いいね!", "閲覧", "作成日時", "更新日時", ""];
    const tables = [...document.querySelectorAll("table")];
    const matches = tables.map((table, index) => {
      const headers = [...table.querySelectorAll("thead th")].map(text);
      return { table, index, headers };
    }).filter(item => item.headers.length === observedHeaders.length &&
      item.headers.every((header, index) => header === observedHeaders[index]));
    const selected = matches.length === 1 ? matches[0] : null;
    const ACTIONABLE =
      'a, button, input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]';
    const rows = selected ? [...selected.table.querySelectorAll("tbody tr")].map(row => {
      const cells = [...row.querySelectorAll(":scope > td")];
      return { title: text(cells[1]), signature: JSON.stringify(cells.map(text)),
        cellCount: cells.length,
        interactiveCount: Number(row.matches(ACTIONABLE)) +
          row.querySelectorAll(ACTIONABLE).length +
          cells.filter(cell => cell.matches(ACTIONABLE)).length };
    }) : [];
    return { documentUrl: document.location.href,
      loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      paginationControls: document.querySelectorAll(
        '[data-testid="pagination-next-button"], [data-testid="pagination-prev-button"]').length,
      tableIndex: selected?.index ?? -1, headerCount: selected?.headers.length ?? 0,
      titleColumn: selected ? selected.headers.indexOf("商品名") : -1,
      tableMatches: matches.length, rows };
  }, undefined, { timeout: UI_OPERATION_TIMEOUT_MS });
  return { ...data, url: page.url() };
}

/** Reads only the two observed form fields; never fills, saves, or creates. */
async function readDetailDom(page) {
  const data = await page.locator("body").evaluate(() => {
    const names = [...document.querySelectorAll('input[name="name"]')];
    const codes = [...document.querySelectorAll('input[name="variants.0.skuCode"]')];
    return { documentUrl: document.location.href,
      loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      nameFieldCount: names.length, skuFieldCount: codes.length,
      title: names.length === 1 ? names[0].value : null,
      skuCode: codes.length === 1 ? codes[0].value : null };
  }, undefined, { timeout: UI_OPERATION_TIMEOUT_MS });
  return { ...data, url: page.url() };
}

function browserAdapter(page) {
  return {
    goto: url => page.goto(url, { waitUntil: "domcontentloaded",
      timeout: UI_OPERATION_TIMEOUT_MS }),
    list: () => readListDom(page), detail: () => readDetailDom(page),
    clickRow: (tableIndex, index) => page.locator("table").nth(tableIndex)
      .locator("tbody tr").nth(index).click({ timeout: UI_OPERATION_TIMEOUT_MS }),
    wait: ms => page.waitForTimeout(ms),
  };
}

/**
 * Reads every draft twice through its list row and exact detail URL. A changed,
 * loading, unopenable, or unidentified row stops the entire result. The result
 * is advisory and can never authorize a Shops CREATE send. DOM stability does
 * not prove that a remote read response belongs to the URL draft ID.
 */
export async function collectGeneralPrivateCreateDraftDetailsReadOnly({ page,
  shopId, expectedRowCount, adapter = null }) {
  if (!ID.test(shopId ?? "") || !Number.isSafeInteger(expectedRowCount) ||
      expectedRowCount < 1 || expectedRowCount > 50 || !adapter && !page)
    return fixed("DRAFT_INPUT_UNVERIFIED");
  const ui = adapter ?? browserAdapter(page);
  const listUrl = `${SHOP_ORIGIN}/seller/shops/${shopId}/products?tab=draft`;
  try {
    await ui.goto(listUrl);
    const first = await stableList(ui, listUrl, expectedRowCount);
    if (!first) return fixed("DRAFT_LIST_UNVERIFIED");
    const rows = [];
    for (let pass = 0; pass < 2; pass++) {
      const seen = new Set();
      for (let index = 0; index < expectedRowCount; index++) {
        await ui.goto(listUrl);
        if (!await stableList(ui, listUrl, expectedRowCount, first))
          return fixed("DRAFT_LIST_CHANGED");
        await ui.clickRow(first.tableIndex, index);
        const detail = await ui.detail();
        await ui.wait(LIST_WAIT_MS);
        const stable = await ui.detail();
        const id = validDetail(detail, shopId);
        if (!id || !same(detail, stable) ||
            clean(detail.title) !== clean(first.rows[index].title) ||
            seen.has(id)) return fixed("DRAFT_DETAIL_UNVERIFIED");
        seen.add(id);
        const row = { draftId: id, title: detail.title,
          skuCode: detail.skuCode || null };
        if (pass === 0) rows.push(row);
        else if (!same(rows[index], row)) return fixed("DRAFT_LIST_CHANGED");
      }
    }
    await ui.goto(listUrl);
    if (!await stableList(ui, listUrl, expectedRowCount, first))
      return fixed("DRAFT_LIST_CHANGED");
    return { status: "DRAFT_DETAILS_DOM_OBSERVED", rows,
      allowFinalCreate: false };
  } catch { return fixed("DRAFT_READ_UNAVAILABLE"); }
}
