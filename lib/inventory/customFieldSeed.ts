import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList } from "@/lib/amplify/listAll";

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
  // ZAICO sync (implementation instructions §9): "●売却の優先度" has no
  // existing BELLO field whose meaning matches it — see
  // lib/inventory/zaicoMapping.ts's ZAICO_ATTRIBUTE_MAP comment for why
  // this, rather than adminMemo or a new Inventory column, was judged
  // the most faithful of the options offered.
  { fieldKey: "salePriority", label: "売却の優先度", fieldType: "TEXT" },

  // ── 2026-09-02 ZAICO全項目監査で追加(lib/inventory/zaicoMapping.ts) ──
  //
  // ZAICOのraw responseに実際に値が入っているのに、BELLO側に受け皿が
  // 無かった項目。新しいInventory列(schema変更 = 再デプロイが必要で、
  // 失敗時の巻き戻しも重い)ではなく、既存のCustomFieldDefinition機構で
  // 受ける — この仕組みは追加のみで既存データに一切触れない。
  //
  // 「売却時配送料金」と既存の「送料」(shippingCost)は別概念。前者は
  // 売却時に発生した配送料金、後者は仕入時にBELLOが負担した送料で、
  // ZAICOも別項目として持っている。統合しない(指示書§14)。
  { fieldKey: "material", label: "材質", fieldType: "TEXT" },
  { fieldKey: "newOrUsed", label: "新品or中古", fieldType: "TEXT" },
  { fieldKey: "saleShippingCost", label: "売却時配送料金", fieldType: "TEXT" },
  { fieldKey: "netSaleProceeds", label: "手元に入ってきた売上金", fieldType: "TEXT" },
  { fieldKey: "transferDate", label: "振込日", fieldType: "TEXT" },
  { fieldKey: "entryMemo", label: "記入メモ", fieldType: "TEXTAREA" },
];

export async function seedCustomFieldDefinitions(): Promise<void> {
  // A raw, isActive-agnostic list — a definition an ADMIN deliberately
  // deactivated must still count as "already present" here (same
  // reasoning as seedInventoryMasters' own duplicate check), otherwise
  // re-seeding would create a second row under the same fieldKey the
  // moment someone turned one off. fieldKey has a secondaryIndex but
  // that's not a uniqueness constraint in Amplify Data, so this check is
  // the only thing actually preventing that.
  // 上のコメントのとおり、この照合が同一fieldKeyの2件目を防ぐ**唯一の**
  // 仕組み。取得に失敗して0件が返ると、全項目をもう一度seedしてしまう。
  const existing = unwrapList(
    await serverDataClient.models.CustomFieldDefinition.list(inventoryAuthMode),
    "追加項目の定義",
  );
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
