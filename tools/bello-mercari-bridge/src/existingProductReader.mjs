import { openExistingProductReadSession } from "./session.mjs";

const unobserved = () => ({ kind: "UNOBSERVED" });
const observed = value => ({ kind: "OBSERVED", value });

function singleValue(rows, label) {
  const matches = rows.filter(row => row.label === label && typeof row.value === "string");
  return matches.length === 1 && matches[0].value.trim() ? observed(matches[0].value.trim()) : unobserved();
}

function yenValue(rows) {
  const raw = singleValue(rows, "販売価格");
  if (raw.kind === "UNOBSERVED" || !/^[0-9][0-9,]*$/.test(raw.value)) return unobserved();
  const amount = Number(raw.value.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? observed(amount) : unobserved();
}

function navigationState(actualUrl, expectedUrl) {
  try {
    const actual = new URL(actualUrl);
    if (actual.origin === "https://mercari-shops.com" && actual.pathname.startsWith("/signin/")) return "AUTH_REQUIRED";
    return actual.href === expectedUrl ? "EXACT" : "UNVERIFIED";
  } catch { return "UNVERIFIED"; }
}

/** A deliberately partial exact-edit read. No field is inferred by input order. */
export function createExistingProductReader({ root, profileDir, playwrightModulePath, shopId,
  launchPersistentContext = null }) {
  return {
    async readExactProduct({ accountReference, remoteId }) {
      if (accountReference !== shopId) return { kind: "UNVERIFIED" };
      const { context, page, state } = await openExistingProductReadSession({
        root, profileDir, playwrightModulePath, shopId, remoteId, launchPersistentContext,
      });
      try {
        if (state === "AUTH_REQUIRED") return { kind: "AUTH_REQUIRED" };
        if (state !== "NAVIGATED_UNVERIFIED") return { kind: "UNVERIFIED" };
        const expectedUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
        const [headingCount, nextButtonCount] = await Promise.all([
          page.getByRole("heading", { name: "商品管理", exact: true }).count(),
          page.getByRole("button", { name: "公開設定に進む", exact: true }).count(),
        ]);
        if (headingCount !== 1 || nextButtonCount !== 1) return { kind: "UNVERIFIED" };
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
          return { documentUrl: document.location.href, rows };
        });
        const documentState = navigationState(snapshot?.documentUrl, expectedUrl);
        const finalState = navigationState(page.url(), expectedUrl);
        if (documentState === "AUTH_REQUIRED" || finalState === "AUTH_REQUIRED") return { kind: "AUTH_REQUIRED" };
        if (documentState !== "EXACT" || finalState !== "EXACT" || !Array.isArray(snapshot.rows))
          return { kind: "UNVERIFIED" };
        const rows = snapshot.rows;
        return { kind: "OBSERVED", observation: {
          exactProductReadBack: true,
          accountReference: observed(shopId), remoteId: observed(remoteId),
          // The exact edit screen has no private/public label. A separately correlated list read is required.
          visibility: unobserved(),
          fields: {
            inventoryCode: singleValue(rows, "商品管理コード"),
            title: singleValue(rows, "商品名"),
            description: singleValue(rows, "商品の説明"),
            priceYen: yenValue(rows),
            // Two unlabelled spinbuttons were observed; never infer quantity by ordinal position.
            quantity: unobserved(),
            primaryImageIdentity: unobserved(),
          },
        } };
      } finally {
        await context.close();
      }
    },
  };
}
