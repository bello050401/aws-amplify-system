import { withShopListingSend } from "./listingSendGate.mjs";

const normalize = value => typeof value === "string" ?
  value.replace(/\s+/g, "").replace(/＞/g, ">") : "";
const priceMatches = (actual, expected) =>
  typeof actual === "string" &&
  /^(?:[¥￥]\s*)?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(actual) &&
  Number(actual.replace(/[¥￥,\s]/g, "")) === expected;

/** Compare the live seller form immediately before the only private-save click. */
export function exactPrivateCreateFinalView(snapshot, view, categoryPath, shipping) {
  if (!snapshot || !view || !Array.isArray(categoryPath) ||
      categoryPath.length < 2 || !shipping) return false;
  const fields = view.fields;
  if (!fields || fields.name !== snapshot.title ||
      fields.description !== snapshot.description ||
      !priceMatches(fields.price, snapshot.testPriceYen) ||
      fields["variants.0.quantity"] !== String(snapshot.quantity) ||
      fields["variants.0.skuCode"] !== snapshot.testManagementCode ||
      normalize(view.condition) !== "目立った傷や汚れなし" ||
      normalize(view.categoryLeaf) !== normalize(categoryPath.at(-1)) ||
      normalize(view.categoryGroup) !==
        `カテゴリー${categoryPath.map(normalize).join(">")}` ||
      Object.entries(shipping).some(([name, value]) => fields[name] !== value))
    return false;
  return true;
}

export async function readPrivateCreateFinalView(page) {
  return page.locator("body").evaluate(() => {
    const names = ["name", "description", "price", "variants.0.quantity",
      "variants.0.skuCode", "shippingMethodType.id",
      "shippingPayerType.id", "shippingFromState.id",
      "shippingDurationType.id"];
    const fields = Object.fromEntries(names.map(name =>
      [name, document.querySelector(`[name="${name}"]`)?.value ?? null]));
    return { fields,
      condition: document.querySelector('[data-testid="condition-select-box"]')?.textContent ?? null,
      categoryLeaf: document.querySelector('[data-testid="categories"]')?.textContent ?? null,
      categoryGroup: document.querySelector('label[for="category"]')
        ?.closest('[role="group"]')?.textContent ?? null };
  });
}

/** The gate's wait finishes before the verifier runs; a changed form cannot click. */
export async function withVerifiedPrivateCreateSend(root, target,
  verifyAfterWait, action, { gate = withShopListingSend } = {}) {
  if (target?.operation !== "CREATE" ||
      typeof verifyAfterWait !== "function" || typeof action !== "function")
    throw Error("Invalid private create send");
  return gate(root, target, async () => {
    if (await verifyAfterWait() !== true)
      throw Error("PRIVATE_CREATE_FINAL_FORM_CHANGED");
    return action();
  });
}
