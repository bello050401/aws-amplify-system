"use server";

import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { searchBrands } from "@/lib/brands/catalog";

export async function searchBrandsAction(query: string) {
  if (!canEditInventory(await getInventoryRole())) throw new Error("この操作には編集権限が必要です。");
  return searchBrands(query.slice(0, 100));
}
