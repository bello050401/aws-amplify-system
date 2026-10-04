import { openExistingProductReadSession } from "./session.mjs";
import { safeReadDiagnostics } from "./readDiagnostics.mjs";

const unobserved = () => ({ kind: "UNOBSERVED" });
const observed = value => ({ kind: "OBSERVED", value });

function singleValue(rows, label) {
  const matches = rows.filter(row => row.label === label && typeof row.value === "string");
  return matches.length === 1 && matches[0].value.trim() ? observed(matches[0].value.trim()) : unobserved();
}

function yenValue(raw) {
  if (raw.kind === "UNOBSERVED" ||
      !/^(?:[¥￥]\s*)?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(raw.value))
    return unobserved();
  const amount = Number(raw.value.replace(/[¥￥,\s]/g, ""));
  return Number.isSafeInteger(amount) ? observed(amount) : unobserved();
}

function quantityValue(raw) {
  if (raw.kind === "UNOBSERVED" || !/^(?:0|[1-9][0-9]*)$/.test(raw.value)) return unobserved();
  const amount = Number(raw.value);
  return Number.isSafeInteger(amount) ? observed(amount) : unobserved();
}

function navigationState(actualUrl, expectedUrl) {
  try {
    const actual = new URL(actualUrl);
    if (actual.origin === "https://mercari-shops.com" && actual.pathname.startsWith("/signin/")) return "AUTH_REQUIRED";
    return actual.href === expectedUrl ? "EXACT" : "UNVERIFIED";
  } catch { return "UNVERIFIED"; }
}

async function uniqueVisible(locator) {
  if (await locator.count() === 0) {
    try { await locator.first().waitFor({ state: "visible", timeout: 12000 }); }
    catch (error) {
      if (error?.name === "TimeoutError") return "TIMEOUT";
      throw error;
    }
  }
  const count = await locator.count();
  return count === 1 ? "READY" : count === 0 ? "TIMEOUT" : "NOT_UNIQUE";
}

/** A deliberately partial exact-edit read. No field is inferred by input order. */
export function createExistingProductReader({ root, profileDir, playwrightModulePath, shopId,
  launchPersistentContext = null, onTrafficSummary = null, onReadDiagnostics = null }) {
  return {
    async readExactProduct({ accountReference, remoteId }) {
      const diagnose = codes => {
        if (typeof onReadDiagnostics === "function") {
          try { onReadDiagnostics(safeReadDiagnostics(codes)); }
          catch { /* Local diagnostics never alter a read result. */ }
        }
      };
      if (accountReference !== shopId) {
        diagnose(["ACCOUNT_MISMATCH"]);
        return { kind: "UNVERIFIED" };
      }
      const { context, page, state, traffic } = await openExistingProductReadSession({
        root, profileDir, playwrightModulePath, shopId, remoteId, launchPersistentContext,
        observeTraffic: typeof onTrafficSummary === "function",
      });
      try {
        if (state === "AUTH_REQUIRED") return { kind: "AUTH_REQUIRED" };
        if (state !== "NAVIGATED_UNVERIFIED") {
          diagnose(["NAVIGATION_UNVERIFIED"]);
          return { kind: "UNVERIFIED" };
        }
        const expectedUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
        const notReady = code => {
          const current = navigationState(page.url(), expectedUrl);
          if (current === "AUTH_REQUIRED") return { kind: "AUTH_REQUIRED" };
          diagnose([current === "EXACT" ? code : "PAGE_URL_UNVERIFIED"]);
          return { kind: "UNVERIFIED" };
        };
        const heading = await uniqueVisible(page.getByRole("heading", { name: "商品管理", exact: true }));
        if (heading !== "READY")
          return notReady(heading === "TIMEOUT" ? "HEADING_TIMEOUT" : "HEADING_NOT_UNIQUE");
        const nextButton = await uniqueVisible(page.getByRole("button", { name: "公開設定に進む", exact: true }));
        if (nextButton !== "READY")
          return notReady(nextButton === "TIMEOUT" ? "NEXT_BUTTON_TIMEOUT" : "NEXT_BUTTON_NOT_UNIQUE");
        const snapshot = await page.locator("input, textarea").evaluateAll(elements => {
          const wanted = new Set(["商品名", "商品の説明", "商品管理コード", "販売価格"]);
          const rows = elements.flatMap(element => {
            if (element instanceof HTMLInputElement && ["hidden", "password"].includes(element.type)) return [];
            const container = element.parentElement?.parentElement;
            const inputs = container?.querySelectorAll("input, textarea") ?? [];
            const labels = container?.querySelectorAll("label") ?? [];
            if (inputs.length !== 1 || inputs[0] !== element || labels.length !== 1) return [];
            const text = labels[0].textContent ?? "";
            const label = text.replace(/\s+/g, "").replace(/(任意|必須)$/, "");
            return wanted.has(label) ? [{ label, value: element.value }] : [];
          });
          const variantQuantities = elements.filter(element => element instanceof HTMLInputElement &&
            /^variants\.[0-9]+\.quantity$/.test(element.name));
          let quantityContract = variantQuantities.length > 1 ? "MULTIPLE_VARIANTS" : "NOT_EXTRACTED";
          if (variantQuantities.length === 1) {
            const field = variantQuantities[0];
            const container = field.parentElement;
            const inputs = container?.querySelectorAll("input, textarea") ?? [];
            const labels = container?.querySelectorAll("label") ?? [];
            if (field.name === "variants.0.quantity" && field.type === "number" &&
                container?.tagName === "DIV" && inputs.length === 1 && inputs[0] === field &&
                labels.length === 1 && (labels[0].textContent ?? "").replace(/\s+/g, "") === "数量") {
              quantityContract = "SINGLE_VARIANT_0";
              rows.push({ label: "数量", value: field.value });
            }
          }
          return { documentUrl: document.location.href, rows, quantityContract };
        });
        const documentState = navigationState(snapshot?.documentUrl, expectedUrl);
        const finalState = navigationState(page.url(), expectedUrl);
        if (documentState === "AUTH_REQUIRED" || finalState === "AUTH_REQUIRED") return { kind: "AUTH_REQUIRED" };
        if (documentState !== "EXACT" || finalState !== "EXACT" || !Array.isArray(snapshot?.rows)) {
          diagnose([...(documentState !== "EXACT" ? ["DOCUMENT_URL_UNVERIFIED"] : []),
            ...(finalState !== "EXACT" ? ["PAGE_URL_UNVERIFIED"] : []),
            ...(!Array.isArray(snapshot?.rows) ? ["FIELD_ROWS_INVALID"] : [])]);
          return { kind: "UNVERIFIED" };
        }
        const rows = snapshot.rows;
        const inventoryCode = singleValue(rows, "商品管理コード");
        const title = singleValue(rows, "商品名");
        const description = singleValue(rows, "商品の説明");
        const rawPrice = singleValue(rows, "販売価格");
        const priceYen = yenValue(rawPrice);
        const rawQuantity = snapshot.quantityContract === "SINGLE_VARIANT_0" ?
          singleValue(rows, "数量") : unobserved();
        const quantity = quantityValue(rawQuantity);
        diagnose([...(title.kind === "UNOBSERVED" ? ["TITLE_UNOBSERVED"] : []),
          ...(description.kind === "UNOBSERVED" ? ["DESCRIPTION_UNOBSERVED"] : []),
          ...(inventoryCode.kind === "UNOBSERVED" ? ["INVENTORY_CODE_UNOBSERVED"] : []),
          ...(rawPrice.kind === "UNOBSERVED" ? ["PRICE_FIELD_NOT_EXTRACTED"] :
            priceYen.kind === "UNOBSERVED" ? ["PRICE_FORMAT_UNSUPPORTED"] : []),
          ...(snapshot.quantityContract === "MULTIPLE_VARIANTS" ? ["QUANTITY_MULTIPLE_VARIANTS"] :
            rawQuantity.kind === "UNOBSERVED" ? ["QUANTITY_FIELD_NOT_EXTRACTED"] :
            quantity.kind === "UNOBSERVED" ? ["QUANTITY_FORMAT_UNSUPPORTED"] : [])]);
        return { kind: "OBSERVED", observation: {
          exactProductReadBack: true,
          accountReference: observed(shopId), remoteId: observed(remoteId),
          // The exact edit screen has no private/public label. A separately correlated list read is required.
          visibility: unobserved(),
          fields: {
            inventoryCode, title, description, priceYen,
            // The exact single-variant name and its unique direct-parent label are both required.
            quantity,
            primaryImageIdentity: unobserved(),
          },
        } };
      } finally {
        if (traffic) {
          traffic.stop();
          try { onTrafficSummary(traffic.snapshot()); } catch { /* UI diagnostics never alter a read result. */ }
        }
        await context.close();
      }
    },
  };
}
