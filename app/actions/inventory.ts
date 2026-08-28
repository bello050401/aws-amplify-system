"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import {
  canEditInventory,
  canHardDeleteInventory,
  getCurrentInventoryUserEmail,
  getInventoryRole,
} from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listLocations, listStatuses } from "@/lib/inventory/queries";
import { stringifyCustomFields } from "@/lib/inventory/customFieldsCodec";
import { copyInventoryImage, removeInventoryImage } from "@/lib/inventory/imageServerOps";
import { diffField, logInventoryHistory } from "@/lib/inventory/history";

/**
 * What the client sends for one image slot (see ImageEditor.tsx):
 * - "uploaded": already at its final S3 key (a fresh upload, or an
 *   unchanged "existing" image on an edit) — used as-is.
 * - "copy": borrowed from another Inventory record (duplicate only) —
 *   resolveImages() copies it to a brand-new key before it's ever
 *   written onto this record, so two records never share one S3 object.
 */
export type ImageSlotInput = { kind: "uploaded"; storageKey: string; sortOrder: number } | { kind: "copy"; sourceStorageKey: string; sortOrder: number };

async function resolveImages(images: ImageSlotInput[]): Promise<{ storageKey: string; sortOrder: number }[]> {
  return Promise.all(
    images.map(async (img) => {
      if (img.kind === "uploaded") return { storageKey: img.storageKey, sortOrder: img.sortOrder };
      // Keep the source's original filename/extension in the new key —
      // cosmetic (S3 preserves Content-Type across a copy regardless),
      // but a key ending in the wrong extension is needlessly confusing
      // if anyone ever has to read these keys directly (S3 console, logs).
      const sourceFileName = img.sourceStorageKey.split("/").pop() ?? "copy.jpg";
      const newKey = await copyInventoryImage(img.sourceStorageKey, sourceFileName);
      return { storageKey: newKey, sortOrder: img.sortOrder };
    }),
  );
}

export interface InventoryFieldsInput {
  name: string;
  categoryId?: string;
  statusId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  images: ImageSlotInput[];
  customFields?: Record<string, unknown>;
}

/**
 * Every write below passes `inventoryAuthMode` — Inventory-area models
 * carry no `allow.publicApiKey()` rule at all (see amplify/data/resource.ts),
 * so a call without it is rejected outright, not just falling back to a
 * degraded path. See lib/amplify/dataClient.ts for why this constant is
 * kept separate from Feature's `adminAuthMode`.
 */
export async function createInventory(input: InventoryFieldsInput): Promise<never> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("在庫を登録する権限がありません（ADMIN または EDITOR のみ）。");
  }

  const name = input.name.trim();
  if (!name) throw new Error("商品名を入力してください。");

  // SKU is never user-entered (spec revision): a fresh, guaranteed-unique
  // value comes from the generateInventorySku Lambda's atomic DynamoDB
  // counter (see amplify/functions/generate-sku) — not "read the max SKU
  // and +1", which races under concurrent registrations. See that
  // function's own comment for why a plain conditional-write retry loop
  // isn't needed either: a native `ADD` is already race-free. This
  // applies identically whether this is a fresh registration or
  // confirming a duplicate — a duplicate never reuses the source's SKU.
  const { data: sku, errors: skuErrors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
  if (skuErrors || !sku) {
    throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(skuErrors)}`);
  }

  const who = await getCurrentInventoryUserEmail();
  const images = await resolveImages(input.images);

  const { data: created, errors } = await serverDataClient.models.Inventory.create(
    {
      sku,
      name,
      categoryId: input.categoryId || undefined,
      statusId: input.statusId || undefined,
      locationId: input.locationId || undefined,
      quantity: input.quantity ?? 0,
      unit: input.unit?.trim() || undefined,
      purchasePrice: input.purchasePrice,
      salePrice: input.salePrice,
      note: input.note?.trim() || undefined,
      images,
      customFields: stringifyCustomFields(input.customFields),
      createdBy: who ?? undefined,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );

  if (errors || !created) {
    throw new Error(`在庫の登録に失敗しました: ${JSON.stringify(errors)}`);
  }

  await logInventoryHistory(created.id, who, [{ fieldName: "登録", oldValue: null, newValue: `SKU ${sku} を新規登録` }]);

  revalidatePath("/inventory");
  redirect(`/inventory/${created.id}`);
}

/**
 * Edit (spec: same fields as registration, minus SKU — never editable
 * here, it's the system-issued identifier). Diffs against the record's
 * current DB state (fetched here, not trusted from the client) to write
 * one InventoryHistory row per changed field, then removes whichever
 * previously-attached images are no longer in the submitted list —
 * computed the same safe way, against the server's own view of what was
 * actually on the record before this edit.
 */
export async function updateInventory(inventoryId: string, input: InventoryFieldsInput): Promise<never> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("在庫を編集する権限がありません（ADMIN または EDITOR のみ）。");
  }

  const name = input.name.trim();
  if (!name) throw new Error("商品名を入力してください。");

  const [existing, categories, locations, statuses] = await Promise.all([
    getInventoryDetail(inventoryId),
    listCategories(),
    listLocations(),
    listStatuses(),
  ]);
  if (!existing) throw new Error("対象の在庫が見つかりません。");

  const who = await getCurrentInventoryUserEmail();
  const images = await resolveImages(input.images);

  const { errors } = await serverDataClient.models.Inventory.update(
    {
      id: inventoryId,
      name,
      categoryId: input.categoryId || undefined,
      statusId: input.statusId || undefined,
      locationId: input.locationId || undefined,
      quantity: input.quantity ?? 0,
      unit: input.unit?.trim() || undefined,
      purchasePrice: input.purchasePrice,
      salePrice: input.salePrice,
      note: input.note?.trim() || undefined,
      images,
      customFields: stringifyCustomFields(input.customFields),
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`在庫の更新に失敗しました: ${JSON.stringify(errors)}`);

  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? id;
  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? id;
  const statusLabel = (id: string | null) => statuses.find((s) => s.id === id)?.label ?? id;

  const oldImageKeys = existing.images.map((i) => i.storageKey);
  const newImageKeys = images.map((i) => i.storageKey);
  const imagesChanged = oldImageKeys.length !== newImageKeys.length || oldImageKeys.some((k, i) => k !== newImageKeys[i]);

  const changes = [
    diffField("商品名", existing.name, name),
    diffField("カテゴリ", categoryName(existing.categoryId), categoryName(input.categoryId ?? null)),
    diffField("保管場所", locationName(existing.locationId), locationName(input.locationId ?? null)),
    diffField("ステータス", statusLabel(existing.statusId), statusLabel(input.statusId ?? null)),
    diffField("数量", existing.quantity, input.quantity ?? 0),
    diffField("単位", existing.unit, input.unit),
    diffField("仕入単価", existing.purchasePrice, input.purchasePrice),
    diffField("販売価格", existing.salePrice, input.salePrice),
    diffField("備考", existing.note, input.note),
    diffField("追加項目", JSON.stringify(existing.customFields ?? {}), JSON.stringify(input.customFields ?? {})),
    imagesChanged ? { fieldName: "画像", oldValue: `${oldImageKeys.length}枚`, newValue: `${newImageKeys.length}枚` } : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  await logInventoryHistory(inventoryId, who, changes);

  // Clean up S3 objects for images the edit actually removed — never
  // images the "copy"/"uploaded" resolution just created, and never
  // before the Inventory write above has already succeeded.
  const removedKeys = oldImageKeys.filter((k) => !newImageKeys.includes(k));
  await Promise.allSettled(removedKeys.map((k) => removeInventoryImage(k)));

  revalidatePath("/inventory");
  revalidatePath(`/inventory/${inventoryId}`);
  redirect(`/inventory/${inventoryId}`);
}

/**
 * Hard delete (spec §3: soft-delete/restore is explicitly deferred to a
 * later phase — "現段階では完全削除でも構いません"). ADMIN-only,
 * enforced here for a clean error message and, independently, by the
 * schema itself (`Inventory`'s `.authorization()` in
 * amplify/data/resource.ts grants EDITOR only read/create/update — no
 * delete — so this can't be bypassed by skipping this check).
 *
 * InventoryHistory rows for this item are deliberately left in place —
 * an audit trail documenting what happened to a since-deleted item is
 * exactly what it's for; deleting them along with the item would erase
 * the one record of it ever having existed. The SKU counter
 * (amplify/functions/generate-sku) is never touched here either — spec
 * requires a deleted SKU stay retired, and the counter only ever moves
 * forward.
 */
export async function deleteInventory(inventoryId: string): Promise<never> {
  const role = await getInventoryRole();
  if (!canHardDeleteInventory(role)) {
    throw new Error("在庫を削除する権限がありません（ADMIN のみ）。");
  }

  const existing = await getInventoryDetail(inventoryId);
  if (!existing) throw new Error("対象の在庫が見つかりません。");

  const who = await getCurrentInventoryUserEmail();

  const { errors } = await serverDataClient.models.Inventory.delete({ id: inventoryId }, inventoryAuthMode);
  if (errors) throw new Error(`在庫の削除に失敗しました: ${JSON.stringify(errors)}`);

  await logInventoryHistory(inventoryId, who, [{ fieldName: "削除", oldValue: "有効", newValue: "削除済み" }]);
  await Promise.allSettled(existing.images.map((img) => removeInventoryImage(img.storageKey)));

  revalidatePath("/inventory");
  redirect("/inventory");
}
