"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { stringifyCustomFields } from "@/lib/inventory/customFieldsCodec";

export interface InventoryImageInput {
  storageKey: string;
  sortOrder: number;
}

export interface CreateInventoryInput {
  name: string;
  categoryId?: string;
  statusId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  images: InventoryImageInput[];
  customFields?: Record<string, unknown>;
}

/**
 * Every write below passes `inventoryAuthMode` — Inventory-area models
 * carry no `allow.publicApiKey()` rule at all (see amplify/data/resource.ts),
 * so a call without it is rejected outright, not just falling back to a
 * degraded path. See lib/amplify/dataClient.ts for why this constant is
 * kept separate from Feature's `adminAuthMode`.
 */
export async function createInventory(input: CreateInventoryInput): Promise<never> {
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
  // isn't needed either: a native `ADD` is already race-free.
  const { data: sku, errors: skuErrors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
  if (skuErrors || !sku) {
    throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(skuErrors)}`);
  }

  const who = await getCurrentInventoryUserEmail();

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
      images: input.images,
      customFields: stringifyCustomFields(input.customFields),
      createdBy: who ?? undefined,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );

  if (errors || !created) {
    throw new Error(`在庫の登録に失敗しました: ${JSON.stringify(errors)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory/${created.id}`);
}
