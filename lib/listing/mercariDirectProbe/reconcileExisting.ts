/** Read-only comparison for an already existing Shops product. No transport or write path. */
export const MERCARI_COMPARISON_FIELDS = [
  "inventoryCode", "title", "description", "priceYen", "quantity", "categoryPath",
  "brand", "condition", "shippingMethod", "shippingPayer", "shippingOrigin",
  "shippingDays", "imageCount", "primaryImageIdentity",
] as const;

export type MercariComparisonField = (typeof MERCARI_COMPARISON_FIELDS)[number];
export type Observation<T> = { kind: "OBSERVED"; value: T } | { kind: "UNOBSERVED" };
export type FieldValue = string | number;
export type FieldResult = "MATCH" | "DIFFERENT" | "UNOBSERVED" | "NO_BELLO_EXPECTATION";

export interface ExpectedExistingProduct {
  accountReference: string;
  remoteId: string;
  fields: Partial<Record<MercariComparisonField, FieldValue>>;
}

export interface ObservedExistingProduct {
  /** Caller must supply observations from the same exact product, not a search result or draft. */
  exactProductReadBack: boolean;
  accountReference: Observation<string>;
  remoteId: Observation<string>;
  visibility: Observation<"PRIVATE" | "PUBLIC" | "OTHER">;
  fields: Partial<Record<MercariComparisonField, Observation<FieldValue>>>;
}

export interface ExistingProductComparison {
  account: FieldResult;
  remoteId: FieldResult;
  visibility: "PRIVATE_OBSERVED" | "NOT_PRIVATE" | "UNOBSERVED";
  fields: Record<MercariComparisonField, FieldResult>;
  /** An existing remote ID can only be revisited; this result never authorizes create. */
  createAllowed: false;
}

function compare(expected: FieldValue | undefined, observed: Observation<FieldValue> | undefined): FieldResult {
  if (expected === undefined) return "NO_BELLO_EXPECTATION";
  if (!observed || observed.kind === "UNOBSERVED") return "UNOBSERVED";
  return observed.value === expected ? "MATCH" : "DIFFERENT";
}

/** Preserves gaps and differences instead of treating an observed Shops value as a BELLO match. */
export function reconcileExistingMercariProduct(
  expected: ExpectedExistingProduct, observed: ObservedExistingProduct,
): ExistingProductComparison {
  const exact = observed.exactProductReadBack;
  const account = compare(expected.accountReference, exact ? observed.accountReference : undefined);
  const remoteId = compare(expected.remoteId, exact ? observed.remoteId : undefined);
  const sameProduct = account === "MATCH" && remoteId === "MATCH";
  const fields = Object.fromEntries(MERCARI_COMPARISON_FIELDS.map(field => [
    field, compare(expected.fields[field], sameProduct ? observed.fields[field] : undefined),
  ])) as Record<MercariComparisonField, FieldResult>;
  return {
    account,
    remoteId,
    visibility: !sameProduct || observed.visibility.kind === "UNOBSERVED" ? "UNOBSERVED" :
      observed.visibility.value === "PRIVATE" ? "PRIVATE_OBSERVED" : "NOT_PRIVATE",
    fields,
    createAllowed: false,
  };
}
