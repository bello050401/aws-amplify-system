"use server";

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
 * The Server Action boundary for CSV/Excel import (統合改善指示書
 * §12-§17) — thin wrappers around lib/inventory/inventoryImport.ts's
 * pure logic, adding only: ADMIN/EDITOR permission (VIEWER is refused
 * at every one of the three steps, not just the final write — spec
 * §16), and translating the parsed/resolved shapes into what the client
 * wizard needs. Never writes anything to the database except inside
 * executeInventoryImportAction — parse/preview are read-only.
 */
function requireImportPermission(role: Awaited<ReturnType<typeof getInventoryRole>>): void {
  if (!canEditInventory(role)) {
    throw new Error("インポートを実行する権限がありません（ADMIN または EDITOR のみ）。");
  }
}

export async function parseInventoryImportFileAction(formData: FormData): Promise<ParsedImportFile> {
  const role = await getInventoryRole();
  requireImportPermission(role);

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("ファイルが選択されていません。");
  if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("CSV(.csv)またはExcel(.xlsx)ファイルを選択してください。");

  const bytes = await file.arrayBuffer();
  return parseImportFile(file.name, bytes);
}

export async function previewInventoryImportAction(rows: Record<string, string>[], mapping: Record<string, string>): Promise<ImportSummary> {
  const role = await getInventoryRole();
  requireImportPermission(role);

  const outcomes = await resolveImportRows(rows, mapping);
  return summarizeImportOutcomes(outcomes);
}

export async function executeInventoryImportAction(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  sourceLabel: "CSVインポート" | "Excelインポート",
): Promise<ImportExecuteResult> {
  const role = await getInventoryRole();
  requireImportPermission(role);

  const who = await getCurrentInventoryUserEmail();
  // 実行の直前に、DBの最新状態へ対して改めて解決し直す — プレビュー
  // 時点のoutcomeをそのまま信用しない(他ユーザーによる変更が間に
  // 入った場合でも、実際に書き込む内容は常に最新のDB状態に基づく)。
  const outcomes = await resolveImportRows(rows, mapping);
  const result = await executeImportRows(outcomes, who, sourceLabel);

  revalidatePath("/inventory");
  return result;
}
