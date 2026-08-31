import "server-only";
import { AnthropicGatewayProvider } from "./anthropicProvider";
import { BedrockGatewayProvider } from "./bedrockProvider";
import { NovaGatewayProvider } from "./novaProvider";
import { routeGenerateText, routeGenerateStructured } from "./router";
import { recordAIUsage } from "./usageLog";
import type { AIGeneratePolicy, AIGenerateResult, AITask, AIToolSchema } from "./types";
import type { TextQualityRules } from "./qualityGate";

/**
 * §3: AI Gateway — 業務コードが実際にimportする唯一の入口。
 * 「OpenAIを呼ぶ」ではなく「このタスクをこの品質クラスで実行する」と
 * 依頼する、という仕様書§3.2の考え方をそのまま体現する。
 *
 * Provider切替は`AI_GATEWAY_PROVIDER`環境変数(既存lib/ai/の
 * AI_PROVIDER環境変数とは別物。あちらはBASE特集ページ専用、こちらは
 * BELLO EC/メッセージ専用で意図的に独立させている)。
 *
 * ## 既定の選び方(夜間長時間・全課題解決指示書 §6)
 *
 * 以前は無条件にAnthropic直APIを返しており、`ANTHROPIC_API_KEY`が
 * 未設定の環境では商品説明の自動生成が
 * 「ANTHROPIC_API_KEYが設定されていません。」で必ず失敗していた。
 * BELLOはAWS上でIAMロールを持って動いているので、APIキーが無いときは
 * **Amazon Bedrock**を既定にする — 追加のキー発行も保管も要らない。
 *
 *   AI_GATEWAY_PROVIDER=bedrock    → 常にBedrock
 *   AI_GATEWAY_PROVIDER=anthropic  → 常にAnthropic直API
 *   未指定                          → ANTHROPIC_API_KEYがあればAnthropic、
 *                                     無ければBedrock
 *
 * 明示指定を最優先にしてあるのは、キーがある環境でもBedrockを試せる
 * ようにするため(逆も同様)。
 */
export type GatewayProviderId = "anthropic" | "bedrock" | "nova";

/** 実際にどちらのProviderが選ばれるかを、呼び出さずに判定する(設定画面の表示・テスト用)。 */
export function resolveProviderId(
  env: { AI_GATEWAY_PROVIDER?: string; ANTHROPIC_API_KEY?: string } = process.env as { AI_GATEWAY_PROVIDER?: string; ANTHROPIC_API_KEY?: string },
): GatewayProviderId {
  const explicit = env.AI_GATEWAY_PROVIDER?.trim().toLowerCase();
  if (explicit === "bedrock") return "bedrock";
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "nova") return "nova";
  if (env.ANTHROPIC_API_KEY) return "anthropic";

  // 既定を "bedrock"(Anthropic on Bedrock) から "nova" へ変えた。
  //
  // このアカウントでAnthropicモデルを呼ぶと、モデルを問わず
  //   404 Model use case details have not been submitted for this account.
  // になる。利用者本人がAWSコンソールで利用目的フォームを提出するまで
  // **AI文章生成は一切動かない**。実画面の「AIで下書きを生成」で
  // 用途申請エラーが出続けていたのはこれが原因だった。
  //
  // Amazon Nova は申請なしでそのまま応答する(画像解析側は既にNovaで
  // 動いている)。「申請が終わるまで機能が死んでいる」より
  // 「今動く既定 + 申請後は環境変数1つでClaudeへ戻せる」を選ぶ。
  //   AI_GATEWAY_PROVIDER=bedrock  → Anthropic on Bedrock(申請後)
  //   AI_GATEWAY_PROVIDER=anthropic → Anthropic API(APIキー)
  return "nova";
}

function getProvider() {
  const id = resolveProviderId();
  if (id === "bedrock") return new BedrockGatewayProvider();
  if (id === "nova") return new NovaGatewayProvider();
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
