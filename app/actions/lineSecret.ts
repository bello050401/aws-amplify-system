"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateLineConnection } from "@/lib/messaging/line/adapter";
import type { LineErrorCode } from "@/lib/messaging/line/adapter";
import { clearLineConnectionInSecretsManager, setLineConnectionInSecretsManager } from "@/lib/messaging/line/secretStore";

/**
 * app/actions/mercariSecret.tsと同一のパターン(ADMIN限定、戻り値に
 * TOKEN本体を一切含めない、保存前に実際のLINE APIで疎通確認してから
 * 保存、§92: 検証失敗時は既存の有効な設定を破壊しない)。
 */
async function requireAdmin(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
}

export interface LineConnectionActionResult {
  success: boolean;
  message: string;
  code?: LineErrorCode;
}

export async function setLineConnectionAction(params: { channelSecret: string; accessToken: string }): Promise<LineConnectionActionResult> {
  await requireAdmin();
  const channelSecret = params.channelSecret.trim();
  const accessToken = params.accessToken.trim();
  if (!channelSecret) return { success: false, message: "Channel Secretを入力してください。" };
  if (!accessToken) return { success: false, message: "Channel Access Tokenを入力してください。" };

  const validation = await validateLineConnection({ channelSecret, accessToken });
  if (!validation.ok) return { success: false, message: validation.message, code: validation.code };

  try {
    await setLineConnectionInSecretsManager({ channelSecret, accessToken });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }

  revalidatePath("/inventory/settings");
  return { success: true, message: "LINE接続設定を保存しました（接続確認済み）。" };
}

export async function deleteLineConnectionAction(): Promise<LineConnectionActionResult> {
  await requireAdmin();
  try {
    await clearLineConnectionInSecretsManager();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
  revalidatePath("/inventory/settings");
  return { success: true, message: "LINE接続設定を削除しました。" };
}
