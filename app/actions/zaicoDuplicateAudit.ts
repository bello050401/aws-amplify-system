"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { runZaicoDuplicateAudit, mergeZaicoDuplicate, type ZaicoDuplicateAuditSummary, type ZaicoDuplicateMergeResult } from "@/lib/inventory/zaicoDuplicateAudit";
import { advanceZaicoSourceLinkBackfill, type ZaicoSourceLinkBackfillProgress } from "@/lib/inventory/zaicoSourceLinkBackfill";

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.5/§11.9。
 * R6 P0-1で確立した「Server Actionはthrowせず{ok,data}|{ok,error}を
 * 返す」パターン(app/actions/ai.ts参照)をここでも踏襲する——このAction
 * はADMINが監査結果を見て判断する画面から呼ばれるため、予期しない
 * AWSエラーがNext.jsの汎用エラー表示(P0-1で根治した「Server
 * Components render error」)を再発させないようにする。
 */
function logActionFailure(action: string, correlationId: string, err: unknown) {
  console.error(
    JSON.stringify({
      action,
      correlationId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

export type RunZaicoDuplicateAuditActionResult = { ok: true; data: ZaicoDuplicateAuditSummary } | { ok: false; error: string; correlationId: string };

export async function runZaicoDuplicateAuditAction(): Promise<RunZaicoDuplicateAuditActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (role !== "ADMIN") return { ok: false, error: "ZAICO重複監査はADMIN権限のみ実行できます。", correlationId };
    const data = await runZaicoDuplicateAudit();
    return { ok: true, data };
  } catch (err) {
    logActionFailure("runZaicoDuplicateAuditAction", correlationId, err);
    return { ok: false, error: "監査の実行に失敗しました。時間をおいて再試行してください。", correlationId };
  }
}

export type MergeZaicoDuplicateActionResult = { ok: true; data: ZaicoDuplicateMergeResult } | { ok: false; error: string; correlationId: string };

export async function mergeZaicoDuplicateAction(sourceInventoryId: string, canonicalInventoryId: string): Promise<MergeZaicoDuplicateActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (role !== "ADMIN") return { ok: false, error: "ZAICO重複の統合はADMIN権限のみ実行できます。", correlationId };
    const who = await getCurrentInventoryUserEmail();
    const data = await mergeZaicoDuplicate(sourceInventoryId, canonicalInventoryId, who);
    revalidatePath("/inventory");
    return { ok: true, data };
  } catch (err) {
    logActionFailure("mergeZaicoDuplicateAction", correlationId, err);
    return { ok: false, error: err instanceof Error ? err.message : "重複の統合に失敗しました。", correlationId };
  }
}

export type AdvanceZaicoSourceLinkBackfillActionResult = { ok: true; data: ZaicoSourceLinkBackfillProgress } | { ok: false; error: string; correlationId: string };

export async function advanceZaicoSourceLinkBackfillAction(nextToken: string | null): Promise<AdvanceZaicoSourceLinkBackfillActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (role !== "ADMIN") return { ok: false, error: "ZAICO重複防止リンクの移行はADMIN権限のみ実行できます。", correlationId };
    const data = await advanceZaicoSourceLinkBackfill(nextToken);
    return { ok: true, data };
  } catch (err) {
    logActionFailure("advanceZaicoSourceLinkBackfillAction", correlationId, err);
    return { ok: false, error: "移行処理に失敗しました。時間をおいて再試行してください。", correlationId };
  }
}
