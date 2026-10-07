const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHOP_ORIGIN = "https://mercari-shops.com";
const fixed = status => ({ status, rows: [], allowFinalCreate: false });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clean = value => value.replace(/\s+/g, " ").trim();

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
    snapshot.headerCount === 8 && snapshot.titleColumn === 0 &&
    Array.isArray(snapshot.rows) && snapshot.rows.length === expectedRowCount &&
    snapshot.rows.every(row => typeof row.title === "string" &&
      row.title.length <= 130 && typeof row.signature === "string" &&
      row.signature.length <= 3000);
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
    const tables = [...document.querySelectorAll("table")];
    const matches = tables.map((table, index) => {
      const headers = [...table.querySelectorAll("thead th")].map(text);
      return { table, index, headers };
    }).filter(item => item.headers.length === 8 &&
      item.headers[0] === "商品名" && item.headers.includes("作成日時") &&
      item.headers.includes("更新日時"));
    const selected = matches.length === 1 ? matches[0] : null;
    const rows = selected ? [...selected.table.querySelectorAll("tbody tr")].map(row => {
      const cells = [...row.querySelectorAll(":scope > td")];
      return { title: text(cells[0]), signature: JSON.stringify(cells.map(text)),
        cellCount: cells.length };
    }) : [];
    return { documentUrl: document.location.href,
      loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      paginationControls: document.querySelectorAll(
        '[data-testid="pagination-next-button"], [data-testid="pagination-prev-button"]').length,
      tableIndex: selected?.index ?? -1, headerCount: selected?.headers.length ?? 0,
      titleColumn: selected ? selected.headers.indexOf("商品名") : -1,
      tableMatches: matches.length, rows };
  });
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
  });
  return { ...data, url: page.url() };
}

function browserAdapter(page) {
  return {
    goto: url => page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 }),
    list: () => readListDom(page), detail: () => readDetailDom(page),
    clickRow: (tableIndex, index) => page.locator("table").nth(tableIndex)
      .locator("tbody tr").nth(index).click({ timeout: 12000 }),
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
    const first = await ui.list();
    await ui.wait(600);
    const second = await ui.list();
    if (!validList(first, listUrl, expectedRowCount) ||
        !validList(second, listUrl, expectedRowCount) || !same(first, second) ||
        first.tableMatches !== 1 || first.rows.some(row => row.cellCount !== 8))
      return fixed("DRAFT_LIST_UNVERIFIED");
    const rows = [];
    for (let pass = 0; pass < 2; pass++) {
      const seen = new Set();
      for (let index = 0; index < expectedRowCount; index++) {
        await ui.goto(listUrl);
        const before = await ui.list();
        await ui.wait(600);
        const settled = await ui.list();
        if (!validList(before, listUrl, expectedRowCount) ||
            !same(before, settled) || !same(settled, first))
          return fixed("DRAFT_LIST_CHANGED");
        await ui.clickRow(first.tableIndex, index);
        const detail = await ui.detail();
        await ui.wait(600);
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
    const last = await ui.list();
    await ui.wait(600);
    if (!same(last, first) || !same(await ui.list(), first))
      return fixed("DRAFT_LIST_CHANGED");
    return { status: "DRAFT_DETAILS_DOM_OBSERVED", rows,
      allowFinalCreate: false };
  } catch { return fixed("DRAFT_READ_UNAVAILABLE"); }
}
