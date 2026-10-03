/** Read-only comparison for an already existing Shops product. No transport or write path. */
export const MERCARI_COMPARISON_FIELDS = [
  "inventoryCode", "title", "description", "priceYen", "quantity", "categoryPath",
  "brand", "condition", "shippingMethod", "shippingPayer", "shippingOrigin",
  "shippingDays", "imageCount", "primaryImageIdentity",
];

function compare(expected, observed) {
  if (expected === undefined) return "NO_BELLO_EXPECTATION";
  if (!observed || observed.kind === "UNOBSERVED") return "UNOBSERVED";
  return observed.value === expected ? "MATCH" : "DIFFERENT";
}

/** Preserves gaps and differences instead of treating an observed Shops value as a BELLO match. */
export function reconcileExistingMercariProduct(expected, observed) {
  const exact = observed.exactProductReadBack;
  const account = compare(expected.accountReference, exact ? observed.accountReference : undefined);
  const remoteId = compare(expected.remoteId, exact ? observed.remoteId : undefined);
  const sameProduct = account === "MATCH" && remoteId === "MATCH";
  const fields = Object.fromEntries(MERCARI_COMPARISON_FIELDS.map(field => [
    field, compare(expected.fields[field], sameProduct ? observed.fields[field] : undefined),
  ]));
  return {
    account,
    remoteId,
    visibility: !sameProduct || observed.visibility.kind === "UNOBSERVED" ? "UNOBSERVED" :
      observed.visibility.value === "PRIVATE" ? "PRIVATE_OBSERVED" : "NOT_PRIVATE",
    fields,
    createAllowed: false,
  };
}
