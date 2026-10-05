const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TARGET = { inventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
  inventoryCode: "B005757", shopId: "evkhihBFFNn5hukMS9s36H",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343", priceYen: 98000 };
const CLAIM = ["attemptId", "claimedAt", "inventoryCode", "inventoryId", "kind",
  "listingConfirmed", "priceYen", "schemaVersion", "shopId", "skuCode"].join(",");
const RESULT = ["attemptId", "claimedAt", "inventoryCode", "inventoryId", "kind",
  "listingConfirmed", "outcome", "priceYen", "reasonCode", "schemaVersion",
  "shopId", "skuCode"].join(",");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function privateCreateExportForUpload(input: unknown,
  kind: "BELLO_PRIVATE_CREATE_CLAIM" | "BELLO_PRIVATE_CREATE_UI_ATTEMPT",
  claimedAttemptId?: string): Record<string, unknown> {
  if (!object(input) || input.kind !== kind || input.schemaVersion !== 1 ||
      Object.keys(input).sort().join(",") !==
        (kind === "BELLO_PRIVATE_CREATE_CLAIM" ? CLAIM : RESULT) ||
      typeof input.attemptId !== "string" || !UUID.test(input.attemptId) ||
      (claimedAttemptId && input.attemptId !== claimedAttemptId) ||
      typeof input.claimedAt !== "string" || !ISO.test(input.claimedAt) ||
      !Number.isFinite(Date.parse(input.claimedAt)) ||
      input.inventoryId !== TARGET.inventoryId ||
      input.inventoryCode !== TARGET.inventoryCode || input.shopId !== TARGET.shopId ||
      input.skuCode !== TARGET.skuCode || input.priceYen !== TARGET.priceYen ||
      input.listingConfirmed !== false ||
      (kind === "BELLO_PRIVATE_CREATE_UI_ATTEMPT" &&
        (input.outcome !== "UNVERIFIED" ||
          !["NETWORK_NOT_OBSERVED", "DRAFT_AUTOSAVE_UI_OBSERVED"].includes(
            input.reasonCode as string))))
    throw Error("固定した非公開テストの記録と一致しません。");
  return Object.fromEntries(Object.entries(input));
}
