"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateMercariToken } from "@/lib/listing/mercari/adapter";
import { clearMercariTokenInSecretsManager, setMercariTokenInSecretsManager } from "@/lib/listing/mercari/secretStore";

/**
 * Mercari Shops Personal API Access Tokenの登録/削除(BELLO統合改修
 * master指示書 Phase D)。app/actions/zaicoSecret.tsと同一のパターン
 * (ADMIN限定、戻り値にTOKEN本体を一切含めない、保存前に実際のAPIで
 * 疎通確認してから保存)。
 */
async function requireAdmin(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") {
    throw new Error("この操作にはADMIN権限が必要です。");
  }
}

export interface MercariTokenActionResult {
  success: boolean;
  message: string;
}

export async function setMercariTokenAction(token: string): Promise<MercariTokenActionResult> {
  await requireAdmin();
  const trimmed = token.trim();
  if (!trimmed) return { success: false, message: "TOKENを入力してください。" };

  const validation = await validateMercariToken(trimmed);
  if (!validation.ok) return { success: false, message: validation.message };

  try {
    await setMercariTokenInSecretsManager(trimmed);
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }

  revalidatePath("/inventory/settings");
  return { success: true, message: "Mercari Shops API TOKENを保存しました（接続確認済み）。" };
}

export async function deleteMercariTokenAction(): Promise<MercariTokenActionResult> {
  await requireAdmin();
  try {
    await clearMercariTokenInSecretsManager();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
  revalidatePath("/inventory/settings");
  return { success: true, message: "Mercari Shops API TOKENを削除しました。" };
}
