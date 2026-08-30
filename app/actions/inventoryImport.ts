"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  executeImportRows,
  parseImportFile,
  resolveImportRows,
  summarizeImportOutcomes,
  type ImportExecuteResult,
  type ImportSummary,
  type ParsedImportFile,
} from "@/lib/inventory/inventoryImport";

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §5: 実際に production build + Playwright で
 * 再現・確認した「CSV/Excelインポートで発生するServer Components
 * render error」の根本原因はこのファイルにあった——3つのServer Action
 * が`throw`する設計になっており(壊れたxlsx・空ファイル・ヘッダー行
 * 無し等、既に丁寧な日本語メッセージを用意していた検証エラーも含む)、
 * Next.jsの本番ビルドは`"use server"`関数から投げられた値の
 * `.message`を安全な定型文へ強制的に書き換える(R6 P0-1で確立した、
 * AI自動下書きと全く同じNext.js自身の意図的なセキュリティ機能)。
 * このリポジトリ既存のせっかくの丁寧な検証メッセージが、本番環境では
 * 全て「予期しないエラーが発生しました」へ潰されていた、という実害を
 * 実機再現で確認済み(docs/csv-xlsx-import-error-root-cause-20260830.md)。
 *
 * 修正: P0-1と同じ「throwしない、{ok,data}|{ok:false,error,correlationId}
 * を返す」パターンへ変更する(app/actions/ai.tsのlogActionFailure/
 * safeErrorMessageと同じ規約)。
 */
function logActionFailure(action: string, correlationId: string, context: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      context,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

/** err.messageが常に安全(secretを含まない)であることは既存方針が前提 — Errorでない値だけ汎用文言にフォールバックする。 */
function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function requireImportPermission(role: Awaited<ReturnType<typeof getInventoryRole>>): string | null {
  if (!canEditInventory(role)) {
    return "インポートを実行する権限がありません（ADMIN または EDITOR のみ）。";
  }
  return null;
}

export type ParseInventoryImportFileActionResult = { ok: true; data: ParsedImportFile } | { ok: false; error: string; correlationId: string };

export async function parseInventoryImportFileAction(formData: FormData): Promise<ParseInventoryImportFileActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    const permissionError = requireImportPermission(role);
    if (permissionError) return { ok: false, error: permissionError, correlationId };

    const file = formData.get("file");
    if (!(file instanceof File)) return { ok: false, error: "ファイルが選択されていません。", correlationId };
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      return { ok: false, error: "CSV(.csv)またはExcel(.xlsx)ファイルを選択してください。", correlationId };
    }

    const bytes = await file.arrayBuffer();
    const data = await parseImportFile(file.name, bytes);
    return { ok: true, data };
  } catch (err) {
    logActionFailure("parseInventoryImportFileAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "ファイルの解析に失敗しました。"), correlationId };
  }
}

export type PreviewInventoryImportActionResult = { ok: true; data: ImportSummary } | { ok: false; error: string; correlationId: string };

export async function previewInventoryImportAction(rows: Record<string, string>[], mapping: Record<string, string>): Promise<PreviewInventoryImportActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    const permissionError = requireImportPermission(role);
    if (permissionError) return { ok: false, error: permissionError, correlationId };

    const outcomes = await resolveImportRows(rows, mapping);
    const data = summarizeImportOutcomes(outcomes);
    return { ok: true, data };
  } catch (err) {
    logActionFailure("previewInventoryImportAction", correlationId, { rowCount: rows.length }, err);
    return { ok: false, error: safeErrorMessage(err, "内容確認に失敗しました。"), correlationId };
  }
}

export type ExecuteInventoryImportActionResult = { ok: true; data: ImportExecuteResult } | { ok: false; error: string; correlationId: string };

export async function executeInventoryImportAction(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  sourceLabel: "CSVインポート" | "Excelインポート",
): Promise<ExecuteInventoryImportActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    const permissionError = requireImportPermission(role);
    if (permissionError) return { ok: false, error: permissionError, correlationId };

    const who = await getCurrentInventoryUserEmail();
    // 実行の直前に、DBの最新状態へ対して改めて解決し直す — プレビュー
    // 時点のoutcomeをそのまま信用しない(他ユーザーによる変更が間に
    // 入った場合でも、実際に書き込む内容は常に最新のDB状態に基づく)。
    const outcomes = await resolveImportRows(rows, mapping);
    const data = await executeImportRows(outcomes, who, sourceLabel);

    revalidatePath("/inventory");
    return { ok: true, data };
  } catch (err) {
    logActionFailure("executeInventoryImportAction", correlationId, { rowCount: rows.length, sourceLabel }, err);
    return { ok: false, error: safeErrorMessage(err, "インポートの実行に失敗しました。"), correlationId };
  }
}
