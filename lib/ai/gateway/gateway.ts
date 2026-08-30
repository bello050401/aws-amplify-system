import "server-only";
import { AnthropicGatewayProvider } from "./anthropicProvider";
import { routeGenerateText, routeGenerateStructured } from "./router";
import { recordAIUsage } from "./usageLog";
import type { AIGeneratePolicy, AIGenerateResult, AITask, AIToolSchema } from "./types";
import type { TextQualityRules } from "./qualityGate";

/**
 * §3: AI Gateway — 業務コードが実際にimportする唯一の入口。
 * 「OpenAIを呼ぶ」ではなく「このタスクをこの品質クラスで実行する」と
 * 依頼する、という仕様書§3.2の考え方をそのまま体現する。
 *
 * Provider切替は`AI_GATEWAY_PROVIDER`環境変数(既定: "anthropic" —
 * 既存lib/ai/のAI_PROVIDER環境変数とは別物。あちらはBASE特集ページ
 * 専用、こちらはBELLO EC/メッセージ専用で意図的に独立させている)。
 * 現時点ではAnthropicのみ実装済み — Bedrock等の追加はAWS認証情報
 * 復旧後、実際に利用可能なモデル・リージョンを確認してから追加する
 * (仕様書§17.3「モデル名を推測しない」)。
 */
function getProvider() {
  // 将来Provider追加時、ここのswitchを増やすだけでよい設計。
  return new AnthropicGatewayProvider();
}

export interface GatewayTextRequest {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  tier: AIGeneratePolicy["tier"];
  promptVersion: string;
  qualityRules?: TextQualityRules;
}

/**
 * §3.2 generateText — プレーンテキスト生成。品質ゲート判定→
 * 必要ならescalation→AIUsageLog記録まで、この1関数で完結する。
 */
export async function generateText(req: GatewayTextRequest): Promise<AIGenerateResult<string>> {
  const provider = getProvider();
  let result: AIGenerateResult<string> | null = null;
  try {
    result = await routeGenerateText(provider, {
      task: req.task,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      policy: { initialTier: req.tier, promptVersion: req.promptVersion },
      qualityRules: req.qualityRules,
    });
    const estimatedCostUsd = provider.estimateCost(result.modelId, result.usage);
    await recordAIUsage({ task: req.task, promptVersion: req.promptVersion, result, success: true, estimatedCostUsd });
    return result;
  } catch (err) {
    await recordAIUsage({
      task: req.task,
      promptVersion: req.promptVersion,
      result,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export interface GatewayStructuredRequest<T extends Record<string, unknown>> {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  toolSchema: AIToolSchema;
  tier: AIGeneratePolicy["tier"];
  promptVersion: string;
  requiredNonEmptyFields: (keyof T)[];
}

export async function generateStructured<T extends Record<string, unknown>>(req: GatewayStructuredRequest<T>): Promise<AIGenerateResult<T>> {
  const provider = getProvider();
  let result: AIGenerateResult<T> | null = null;
  try {
    result = await routeGenerateStructured<T>(provider, {
      task: req.task,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      toolSchema: req.toolSchema,
      policy: { initialTier: req.tier, promptVersion: req.promptVersion },
      requiredNonEmptyFields: req.requiredNonEmptyFields,
    });
    const estimatedCostUsd = provider.estimateCost(result.modelId, result.usage);
    await recordAIUsage({ task: req.task, promptVersion: req.promptVersion, result, success: true, estimatedCostUsd });
    return result;
  } catch (err) {
    await recordAIUsage({
      task: req.task,
      promptVersion: req.promptVersion,
      result,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function healthCheck(): Promise<{ ok: boolean; message: string }> {
  return getProvider().healthCheck();
}
