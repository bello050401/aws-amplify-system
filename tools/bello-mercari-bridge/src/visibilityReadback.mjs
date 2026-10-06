import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TITLE = /^[^\x00-\x1f\x7f]{1,130}$/;
const FILTERS = Object.freeze({ PUBLIC: { query: "opened", label: "公開" },
  PRIVATE: { query: "unopened", label: "非公開" } });

/** URL shape was observed by selecting the normal Shops visibility filter and searching. */
export function exactVisibilitySearchUrl(shopId, title, visibility) {
  if (shopId !== PRIVATE_CREATE_SHOP_ID || typeof title !== "string" ||
      !TITLE.test(title) || !title.trim() || !Object.hasOwn(FILTERS, visibility))
    return null;
  const url = new URL(`https://mercari-shops.com/seller/shops/${shopId}/products`);
  url.searchParams.set("tab", "on_sale");
  url.searchParams.set("visibility", FILTERS[visibility].query);
  url.searchParams.set("keyword", title);
  return url.href;
}

const unobserved = code => ({ kind: "UNOBSERVED", code });

/** Read one exact product through the normal filtered list; no edit/save is made. */
export async function readExactVisibilityFromList(page, { shopId, remoteId,
  title, visibility }) {
  const listUrl = exactVisibilitySearchUrl(shopId, title, visibility);
  if (!listUrl || !ID.test(remoteId ?? "")) return unobserved("INVALID_TARGET");
  const expectedEditUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
  try {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (page.url() !== listUrl) return unobserved("LIST_URL_CHANGED");
    const table = page.getByRole("table");
    if (await table.count() === 0)
      await table.waitFor({ state: "visible", timeout: 12000 });
    if (await table.count() !== 1) return unobserved("TABLE_NOT_UNIQUE");
    const titleCell = table.getByRole("cell", { name: title, exact: true });
    const row = table.getByRole("row").filter({ has: titleCell });
    if (await row.count() === 0)
      await row.waitFor({ state: "visible", timeout: 12000 });
    if (await row.count() !== 1) return unobserved("ROW_NOT_UNIQUE");
    const matched = await row.evaluate((element, expected) => {
      if (!(element instanceof HTMLTableRowElement) ||
          element.parentElement?.tagName !== "TBODY" || element.cells.length !== 10)
        return false;
      const cells = Array.from(element.cells);
      if (cells.some(cell => cell.tagName !== "TD" || cell.colSpan !== 1 ||
          cell.rowSpan !== 1)) return false;
      const normalize = cell => (cell.textContent ?? "").replace(/\s+/g, " ").trim();
      return cells[0].querySelectorAll("img").length === 1 &&
        cells[0].querySelector("img")?.getAttribute("alt") === expected.title &&
        normalize(cells[1]) === expected.title &&
        normalize(cells[2]) === expected.label &&
        cells[2].querySelectorAll("p").length === 1 &&
        normalize(cells[2].querySelector("p")) === expected.label;
    }, { title, label: FILTERS[visibility].label });
    if (!matched || page.url() !== listUrl) return unobserved("ROW_CONTENT_CHANGED");
    const cell = row.locator(":scope > td").nth(1);
    if (await cell.count() !== 1) return unobserved("TITLE_CELL_MISSING");
    await cell.click({ timeout: 12000 });
    await page.waitForURL(expectedEditUrl, { timeout: 12000 });
    if (page.url() !== expectedEditUrl) return unobserved("PRODUCT_ID_CHANGED");
    return { kind: "OBSERVED", shopId, remoteId, title, visibility };
  } catch { return unobserved("VISIBILITY_READ_FAILED"); }
}
