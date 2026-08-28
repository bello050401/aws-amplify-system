"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateZaicoToken } from "@/lib/zaico/client";
import { clearZaicoTokenInSecretsManager, setZaicoTokenInSecretsManager } from "@/lib/zaico/secretStore";

/**
 * ZAICO API TOKENの登録/削除 (夜間開発指示書 §14)。ADMIN限定 —
 * app/actions/masters.ts/customFields.tsと同じrequireAdminパターン。
 *
 * 戻り値にTOKEN本体を一切含めない — 成功/失敗の真偽値と、ユーザー向け
 * のメッセージ(検証結果・エラー理由)だけを返す。これにより、ブラウザ
 * 側のJavaScript実行環境にTOKEN文字列が一度も渡らない(保存が成功して
 * も失敗しても、フォームの入力欄が元々持っていた値以外は増えない)。
 */
async function requireAdmin(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") {
    throw new Error("この操作にはADMIN権限が必要です。");
  }
}

export interface ZaicoTokenActionResult {
  success: boolean;
  message: string;
}

/**
 * 保存前にZAICO GET APIで疎通確認する(spec §14: 「成功/認証失敗/通信
 * エラーを判定」) — 確認が取れたものだけをSecrets Managerへ書き込む。
 * 検証に使うトークン値はこの呼び出しの中だけで完結し、ログにも出力し
 * ない(lib/zaico/client.tsのvalidateZaicoToken/getJsonの既存の方針を
 * そのまま踏襲)。
 */
export async function setZaicoTokenAction(token: string): Promise<ZaicoTokenActionResult> {
  await requireAdmin();
  const trimmed = token.trim();
  if (!trimmed) return { success: false, message: "TOKENを入力してください。" };

  const validation = await validateZaicoToken(trimmed);
  if (!validation.ok) return { success: false, message: validation.message };

  try {
    await setZaicoTokenInSecretsManager(trimmed);
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }

  revalidatePath("/inventory/settings");
  return { success: true, message: "ZAICO API TOKENを保存しました（接続確認済み）。" };
}

/**
 * 「削除」— Secretリソース自体は物理削除しない(安全性レビューでの
 * 指摘を反映)。値を「未設定」を表すJSONへ書き戻すだけ
 * (lib/zaico/secretStore.tsのclearZaicoTokenInSecretsManager参照) —
 * ADMIN操作としての見た目・結果("接続済み"→"未設定"に戻る)は変わらない。
 */
export async function deleteZaicoTokenAction(): Promise<ZaicoTokenActionResult> {
  await requireAdmin();
  try {
    await clearZaicoTokenInSecretsManager();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
  revalidatePath("/inventory/settings");
  return { success: true, message: "ZAICO API TOKENを削除しました。" };
}
