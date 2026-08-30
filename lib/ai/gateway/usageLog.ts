import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { AIGenerateResult, AITask } from "./types";

/**
 * §6/§15: AI呼び出し1回につき1行、AIUsageLogへ記録する。プロンプト
 * 全文・顧客メッセージ本文は一切渡さない/保存しない — 呼び出し元は
 * このファイルへメタデータ(トークン数・レイテンシ・成功可否等)しか
 * 渡せない(この関数のシグネチャ自体がその境界を強制する)。
 */
export interface AIUsageLogInput<T> {
  task: AITask;
  promptVersion: string;
  result: AIGenerateResult<T> | null; // nullは失敗時(生成そのものが例外を投げた場合)
  success: boolean;
  errorMessage?: string;
  retryCount?: number;
  estimatedCostUsd?: number | null;
}

export async function recordAIUsage<T>(input: AIUsageLogInput<T>): Promise<void> {
  try {
    await serverDataClient.models.AIUsageLog.create(
      {
        task: input.task,
        providerId: input.result?.providerId ?? "unknown",
        modelId: input.result?.modelId ?? "unknown",
        qualityTier: input.result?.qualityTier ?? "STANDARD",
        inputTokens: input.result?.usage.inputTokens ?? 0,
        outputTokens: input.result?.usage.outputTokens ?? 0,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        latencyMs: input.result?.latencyMs ?? 0,
        success: input.success,
        errorMessage: input.errorMessage,
        retryCount: input.retryCount ?? 0,
        fallbackOccurred: input.result?.fallbackOccurred ?? false,
        qualityGatePassed: input.result?.qualityGatePassed ?? null,
        qualityGateViolations: JSON.stringify(input.result?.qualityGateViolations ?? []),
        promptVersion: input.promptVersion,
      },
      inventoryAuthMode,
    );
  } catch (err) {
    // §157相当: 監査ログの書き込み失敗が、実際のAI生成結果を呼び出し元
    // へ返すことを妨げてはならない(ログは補助情報であり、これが原因で
    // ユーザー向けの本来の処理が失敗扱いになるのは本末転倒)。
    console.error("[recordAIUsage] failed to write AIUsageLog (non-fatal):", err);
  }
}

export interface AIUsageAggregate {
  task: AITask;
  count: number;
  successCount: number;
  fallbackCount: number;
  qualityGateFailureCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  averageLatencyMs: number;
}

/** §7/§8: ChatGPT監査レポート・月次集計向け — task別の全件を取得し、JS側で集計する。 */
export async function listAIUsageLogs(sinceIso?: string): Promise<AIUsageAggregate[]> {
  const { data } = await serverDataClient.models.AIUsageLog.list({ ...inventoryAuthMode, limit: 5000 });
  const rows = sinceIso ? data.filter((r) => r.createdAt >= sinceIso) : data;

  const byTask = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTask.get(row.task) ?? [];
    list.push(row);
    byTask.set(row.task, list);
  }

  return Array.from(byTask.entries()).map(([task, taskRows]) => ({
    task: task as AITask,
    count: taskRows.length,
    successCount: taskRows.filter((r) => r.success).length,
    fallbackCount: taskRows.filter((r) => r.fallbackOccurred).length,
    qualityGateFailureCount: taskRows.filter((r) => r.qualityGatePassed === false).length,
    totalInputTokens: taskRows.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: taskRows.reduce((sum, r) => sum + r.outputTokens, 0),
    totalEstimatedCostUsd: taskRows.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0),
    averageLatencyMs: taskRows.length > 0 ? Math.round(taskRows.reduce((sum, r) => sum + r.latencyMs, 0) / taskRows.length) : 0,
  }));
}
