"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { findInventoryBySku } from "@/lib/inventory/queries";
import { stringifyCustomFields } from "@/lib/inventory/customFieldsCodec";

export interface InventoryImageInput {
  storageKey: string;
  sortOrder: number;
}

export interface CreateInventoryInput {
  sku: string;
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

  const sku = input.sku.trim();
  const name = input.name.trim();
  if (!sku) throw new Error("SKUを入力してください。");
  if (!name) throw new Error("商品名を入力してください。");

  // Best-effort duplicate check, not an atomic guarantee (spec §6/§20
  // deliberately leaves strict same-instant race handling for later —
  // see the secondaryIndexes comment on Inventory in
  // amplify/data/resource.ts). Fine for how this system is actually used:
  // a handful of staff typing SKUs by hand, not concurrent automated writers.
  const existing = await findInventoryBySku(sku);
  if (existing) {
    throw new Error(`SKU「${sku}」は既に「${existing.name}」で使用されています。別のSKUを入力してください。`);
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
