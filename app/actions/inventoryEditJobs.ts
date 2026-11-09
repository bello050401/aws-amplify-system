"use server";
import { inventoryMutationSession } from "@/lib/inventory/mutationSession";
import { inventoryEditRuntime } from "@/lib/inventory/editJobs";
import type { EditJobMode } from "@/lib/inventory/editJobsCore";
import type { InventoryEditRules } from "@/lib/inventory/editTransform";
import {
  inventoryDdb,
  inventoryTable,
} from "@/lib/inventory/categoryPersistence";
import { readInventoryBatch } from "@/lib/inventory/batchRead";
import { inventoryCategoryIds } from "@/lib/inventory/categories";
import {
  readEditHistory,
  inventoryHistoryViews,
} from "@/lib/inventory/reversibleHistory";
async function session() {
  const access = await inventoryMutationSession();
  if (!access) throw Error("在庫を編集する権限がありません。");
  return access;
}
export async function previewInventoryEdits(input: {
  id: string;
  ids: string[];
  mode: EditJobMode;
  rules?: InventoryEditRules;
  targetOperationId?: string;
}) {
  const access = await session();
  return inventoryEditRuntime().create(input, access.owner, access.owner);
}
export async function applyInventoryEdits(id: string) {
  const access = await session();
  return inventoryEditRuntime().apply(id, access.owner);
}
export async function cancelInventoryEdits(id: string) {
  const access = await session();
  return inventoryEditRuntime().cancel(id, access.owner);
}
export async function inventoryEditJobStatus(id: string) {
  const access = await session();
  return inventoryEditRuntime().status(id, access.owner, false);
}
export async function inventoryEditSelection(ids: string[]) {
  await session();
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    ids.some((id) => typeof id !== "string" || id.length > 128)
  )
    throw Error("商品を1,000件以内で選択してください。");
  const rows = await readInventoryBatch(
    inventoryDdb,
    inventoryTable("Inventory"),
    ids,
    undefined,
    ["id", "name", "sku", "categoryIds", "categoryId", "deletedAt"],
  );
  return ids.map((id) => {
    const row = rows.get(id);
    return {
      id,
      name: String(row?.name ?? "取得できない商品"),
      sku: String(row?.sku ?? ""),
      categoryIds: row && !row.deletedAt ? inventoryCategoryIds(row) : [],
    };
  });
}
export async function inventoryRecentHistory(ids: string[]) {
  await session();
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 128)
  )
    throw Error("商品を100件以内で選択してください。");
  const rows = await readInventoryBatch(
    inventoryDdb,
    inventoryTable("Inventory"),
    ids,
  );
  return ids.map((id) => {
    const raw = rows.get(id);
    if (!raw || raw.deletedAt) throw Error("商品が見つかりません。");
    const row = { ...raw, categoryIds: inventoryCategoryIds(raw) };
    return {
      id,
      name: String(raw.name),
      revision: Number(raw.revision ?? 0),
      history: readEditHistory(row),
      views: inventoryHistoryViews(row),
    };
  });
}
export async function inventoryEditOperationTargets(id: string) {
  await session();
  return inventoryEditRuntime().operationTargets(id);
}
