import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * The handful of Phase C items low-frequency enough to go through the
 * existing CustomFieldDefinition/Inventory.customFields mechanism
 * instead of a new Inventory column (see lib/inventory/extendedFields.ts
 * for the fields that DID become real columns, and the reasoning split
 * between the two). Because that mechanism was already built generically
 * in an earlier phase, seeding these definitions is the ONLY code needed
 * here — the existing New/Edit forms' CustomFieldInput and the detail
 * page's customFieldEntries rendering already pick up any active
 * CustomFieldDefinition with no further changes.
 *
 * Idempotent by fieldKey, same additive-only pattern as
 * masterSeed.ts's seedInventoryMasters — only a fieldKey that doesn't
 * already exist gets created; never overwrites an ADMIN's own edits to
 * label/type/options on one of these later.
 */
const CUSTOM_FIELD_SEED: { fieldKey: string; label: string; fieldType: "TEXT" | "TEXTAREA" }[] = [
  { fieldKey: "socketType", label: "口金", fieldType: "TEXT" },
  { fieldKey: "legHeight", label: "脚高", fieldType: "TEXT" },
  { fieldKey: "seatDimensions", label: "座面寸法", fieldType: "TEXT" },
  { fieldKey: "packageSize", label: "梱包サイズ", fieldType: "TEXT" },
  { fieldKey: "usedGoodsFeature", label: "古物の特徴", fieldType: "TEXTAREA" },
];

export async function seedCustomFieldDefinitions(): Promise<void> {
  // A raw, isActive-agnostic list — a definition an ADMIN deliberately
  // deactivated must still count as "already present" here (same
  // reasoning as seedInventoryMasters' own duplicate check), otherwise
  // re-seeding would create a second row under the same fieldKey the
  // moment someone turned one off. fieldKey has a secondaryIndex but
  // that's not a uniqueness constraint in Amplify Data, so this check is
  // the only thing actually preventing that.
  const { data: existing } = await serverDataClient.models.CustomFieldDefinition.list(inventoryAuthMode);
  const existingKeys = new Set(existing.map((f) => f.fieldKey));
  const missing = CUSTOM_FIELD_SEED.filter((f) => !existingKeys.has(f.fieldKey));
  if (missing.length === 0) return;

  const sortOrders = existing.map((f) => f.sortOrder ?? 0);
  let nextSortOrder = sortOrders.length === 0 ? 0 : Math.max(...sortOrders) + 1;
  for (const field of missing) {
    await serverDataClient.models.CustomFieldDefinition.create(
      { fieldKey: field.fieldKey, label: field.label, fieldType: field.fieldType, sortOrder: nextSortOrder, isActive: true },
      inventoryAuthMode,
    );
    nextSortOrder += 1;
  }
}
