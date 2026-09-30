"use server";

import { headers } from "next/headers";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { checkPrivateMasterAcceptance, startPrivateMasterAcceptance,
  PRIVATE_MASTER_STAGING_ORIGIN, type PrivateMasterAcceptanceState } from "@/lib/listing/nextEngine/privateMasterAcceptance";

export type PrivateMasterTestResult = { ok: true; state: PrivateMasterAcceptanceState } | { ok: false; message: string };
const SAFE_MESSAGES = new Set([
  "専用テストの安全確認が完了していません。送信しません。",
  "登録済みの仕入先コードを確認してください。",
  "ネクストエンジンの設定を確認できません。送信しません。",
  "ネクストエンジンの接続が必要です。送信しません。",
  "接続情報を確認できません。送信しません。",
  "一回限りのテスト状態を確認できません。送信しません。",
  "この専用テストは既に開始されています。再送しません。",
  "ネクストエンジンの確認に失敗しました。送信しません。",
  "使用できる仕入先を確認できません。送信しません。",
  "専用テスト商品コードが既に存在するか、件数を確認できません。送信しません。",
  "接続設定が変更されました。送信しません。",
]);

function sameOrigin(): boolean {
  try { return headers().get("origin") === PRIVATE_MASTER_STAGING_ORIGIN; }
  catch { return false; }
}

export async function startNextEnginePrivateMasterTest(supplierCode: string): Promise<PrivateMasterTestResult> {
  if (!sameOrigin()) return { ok: false, message: "この画面から操作してください。" };
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ操作できます。" };
  try { return { ok: true, state: await startPrivateMasterAcceptance(supplierCode) }; }
  catch (error) {
    const message = error instanceof Error && SAFE_MESSAGES.has(error.message) ? error.message
      : "専用テストを開始できませんでした。再送せず担当者に確認してください。";
    return { ok: false, message };
  }
}

export async function checkNextEnginePrivateMasterTest(): Promise<PrivateMasterTestResult> {
  if (!sameOrigin()) return { ok: false, message: "この画面から操作してください。" };
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ操作できます。" };
  try { return { ok: true, state: await checkPrivateMasterAcceptance() }; }
  catch { return { ok: false, message: "テスト商品の状況を確認できません。再送せず担当者に確認してください。" }; }
}
