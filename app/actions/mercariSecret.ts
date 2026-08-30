"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateMercariConnection } from "@/lib/listing/mercari/adapter";
import type { MercariErrorCode } from "@/lib/listing/mercari/client";
import { clearMercariTokenInSecretsManager, setMercariConnectionInSecretsManager } from "@/lib/listing/mercari/secretStore";

/**
 * Mercari Shops接続設定(TOKEN + APIクライアント名)の登録/削除
 * (BELLO統合業務OS指示書 2026-08-30 §24: 「Token欄はあるが
 * `MERCARI_API_CLIENT_NAME`入力欄がない」問題への対応 — 1つの
 * 「接続確認して保存」操作でTOKEN・APIクライアント名の両方をまとめて
 * 検証・保存する)。app/actions/zaicoSecret.tsと同一のパターン
 * (ADMIN限定、戻り値にTOKEN本体を一切含めない、保存前に実際のAPIで
 * 疎通確認してから保存、§92: 検証失敗時は既存の有効な設定を破壊しない
 * — setMercariConnectionInSecretsManagerは検証成功後にしか呼ばれない
 * ので、この関数の外側で失敗時に古い値へ戻す処理は不要)。
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
  code?: MercariErrorCode;
}

export async function setMercariConnectionAction(params: { token: string; clientName: string; clientVersion?: string }): Promise<MercariTokenActionResult> {
  await requireAdmin();
  const token = params.token.trim();
  const clientName = params.clientName.trim();
  const clientVersion = params.clientVersion?.trim() || undefined;
  if (!token) return { success: false, message: "Personal API Access Tokenを入力してください。" };
  if (!clientName) return { success: false, message: "APIクライアント名を入力してください（Mercari Shopsとの契約時に割り当てられた値です）。" };

  const validation = await validateMercariConnection({ token, clientName, clientVersion });
  if (!validation.ok) return { success: false, message: validation.message, code: validation.code };

  try {
    await setMercariConnectionInSecretsManager({ token, clientName, clientVersion });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }

  revalidatePath("/inventory/settings");
  return { success: true, message: "Mercari Shops API接続設定を保存しました（接続確認済み）。" };
}

export async function deleteMercariTokenAction(): Promise<MercariTokenActionResult> {
  await requireAdmin();
  try {
    await clearMercariTokenInSecretsManager();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
  revalidatePath("/inventory/settings");
  return { success: true, message: "Mercari Shops API接続設定を削除しました。" };
}
