import "server-only";
import { BedrockRuntimeClient, ConverseCommand, type Tool } from "@aws-sdk/client-bedrock-runtime";
import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AITokenUsage, AIToolSchema } from "./types";

/**
 * Amazon Nova を使うAIゲートウェイProvider。
 *
 * ## なぜ必要になったか
 *
 * `bedrockProvider.ts` は `@anthropic-ai/bedrock-sdk` を使い、
 * `modelRegistry.ts` の既定モデルは3階層とも `us.anthropic.*` である。
 * このアカウントで Anthropic モデルを呼ぶと、モデルを問わず
 *
 *   404 Model use case details have not been submitted for this account.
 *
 * になる。利用者本人がAWSコンソールで利用目的フォームを提出するまで
 * **AI文章生成は一切動かない**。実画面の「AIで下書きを生成」で
 * 用途申請エラーが出続けていたのはこれが原因だった。
 *
 * 一方、Amazon Nova は申請なしでそのまま応答する(AI Vision の調査時に
 * `us.amazon.nova-lite-v1:0` / `us.amazon.nova-pro-v1:0` で実測済み)。
 * 画像解析側は既に Nova へ切り替えて動いており、文章生成側だけが
 * Anthropic のまま取り残されていた。
 *
 * ## 設計
 *
 * `bedrockProvider.ts` は**変更しない**。Anthropic の利用申請が通れば
 * `AI_GATEWAY_PROVIDER=bedrock` に戻すだけで元の経路が使える。
 * 「今すぐ動く」ことと「将来Claudeへ戻せる」ことを両立させる。
 *
 * SDKが違うのは、Anthropic SDK が Anthropic のAPI形状しか話せないため。
 * Nova は Bedrock の Converse API を使う(画像解析側と同じ経路)。
 */

/** 既定モデル。環境変数で差し替えられる。 */
export const NOVA_MODEL_ECONOMY = process.env.BEDROCK_NOVA_MODEL_ECONOMY || "us.amazon.nova-lite-v1:0";
export const NOVA_MODEL_STANDARD = process.env.BEDROCK_NOVA_MODEL_STANDARD || "us.amazon.nova-pro-v1:0";
export const NOVA_MODEL_PREMIUM = process.env.BEDROCK_NOVA_MODEL_PREMIUM || "us.amazon.nova-pro-v1:0";

/** 階層ごとの出力上限。Novaの上限に合わせた保守的な値。 */
const MAX_OUTPUT_TOKENS = 4096;

export function novaModelForTier(tier: AIGeneratePolicy["tier"]): string {
  if (tier === "PREMIUM") return NOVA_MODEL_PREMIUM;
  if (tier === "ECONOMY") return NOVA_MODEL_ECONOMY;
  return NOVA_MODEL_STANDARD;
}

let cached: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  // 資格情報は明示的に渡さない — 実行ロール(既定の資格情報チェーン)を使う。
  if (!cached) {
    const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2";
    cached = new BedrockRuntimeClient({ region });
  }
  return cached;
}

/**
 * 利用者に見せて安全な説明へ変換する。
 *
 * **上流のメッセージ本文は決して混ぜない。** AWSの権限エラーは本文へ
 * 実行ロールのARN・ロール名・拒否されたアクション名を含めて返してくる。
 * アカウントIDやロール名を利用者向け画面へ出す必要は無い
 * (bedrockProvider.tsのdescribeBedrockErrorと同じ方針)。
 */
export function describeNovaError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "AccessDeniedException") {
    return "AIモデルの呼び出しが権限で拒否されました。実行ロールにBedrockの権限が付与されているか管理者にご確認ください。";
  }
  if (name === "ResourceNotFoundException" || name === "ValidationException") {
    return "AIモデルの設定に問題があります。利用可能なモデルが指定されているか管理者にご確認ください。";
  }
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") {
    return "AIの利用が一時的に混み合っています。しばらく待ってからもう一度お試しください。";
  }
  if (name === "ModelTimeoutException" || name === "TimeoutError" || name === "AbortError") {
    return "AIの応答が時間内に返りませんでした。もう一度お試しください。";
  }
  return "AIの呼び出しに失敗しました。時間をおいてもう一度お試しください。";
}

function usageOf(res: { usage?: { inputTokens?: number; outputTokens?: number } }): AITokenUsage {
  return { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 };
}

export class NovaGatewayProvider implements AIGatewayProvider {
  readonly providerId = "nova" as const;

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    // 実際の推論は課金が発生するため呼び出さない(他Providerと同じ方針)。
    const region = process.env.BEDROCK_REGION || process.env.AWS_REGION;
    if (!region) {
      return { ok: false, message: "リージョンが特定できません（BEDROCK_REGION または AWS_REGION を設定してください）。" };
    }
    return {
      ok: true,
      message:
        `Amazon Nova（${region} / ${novaModelForTier("STANDARD")}）を使用する設定です。実行ロールの資格情報で呼び出します（APIキーも利用申請も不要）。実際の疎通確認は呼び出しコストを避けるため行っていません。`,
    };
  }

  estimateCost(): number | null {
    // Novaの単価表をこのコードへ埋め込まない。実測していない値を
    // 「正しいコスト」として記録するとログが嘘になる(§157 fake success禁止)。
    return null;
  }

  async generateText(
    task: AITask,
    systemPrompt: string,
    userPrompt: string,
    policy: AIGeneratePolicy,
  ): Promise<AIGenerateResult<string>> {
    const modelId = novaModelForTier(policy.tier);
    const startedAt = Date.now();
    let res;
    try {
      res = await client().send(
        new ConverseCommand({
          modelId,
          system: [{ text: systemPrompt }],
          messages: [{ role: "user", content: [{ text: userPrompt }] }],
          inferenceConfig: { maxTokens: policy.maxTokens ?? MAX_OUTPUT_TOKENS, temperature: 0.3 },
        }),
      );
    } catch (err) {
      // 本文は出さない。種別だけ残す。
      console.error(`[NovaGatewayProvider.generateText] task=${task} failed:`, err instanceof Error ? err.name : "UnknownError");
      throw new Error(describeNovaError(err));
    }

    const text = res.output?.message?.content?.find((c) => "text" in c)?.text?.trim();
    if (!text) throw new Error("AI応答にテキスト出力が含まれていませんでした。");

    return {
      output: text,
      usage: usageOf(res),
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true, // Router側で上書きする
      qualityGateViolations: [],
    };
  }

  async generateStructured<T>(
    task: AITask,
    systemPrompt: string,
    userPrompt: string,
    toolSchema: AIToolSchema,
    policy: AIGeneratePolicy,
  ): Promise<AIGenerateResult<T>> {
    const modelId = novaModelForTier(policy.tier);
    const startedAt = Date.now();

    // Converse の toolConfig は Anthropic の tools と形が違うので詰め替える。
    const tool: Tool = {
      toolSpec: {
        name: toolSchema.name,
        description: toolSchema.description,
        // Converse の inputSchema.json は DocumentType。JSON Schema を
        // そのまま渡す用途なので、ここだけは構造を保ったまま通す。
        inputSchema: { json: toolSchema.input_schema as unknown as Record<string, never> },
      },
    };

    let res;
    try {
      res = await client().send(
        new ConverseCommand({
          modelId,
          system: [{ text: systemPrompt }],
          messages: [{ role: "user", content: [{ text: userPrompt }] }],
          toolConfig: { tools: [tool], toolChoice: { tool: { name: toolSchema.name } } },
          inferenceConfig: { maxTokens: policy.maxTokens ?? MAX_OUTPUT_TOKENS, temperature: 0 },
        }),
      );
    } catch (err) {
      console.error(`[NovaGatewayProvider.generateStructured] task=${task} failed:`, err instanceof Error ? err.name : "UnknownError");
      throw new Error(describeNovaError(err));
    }

    const toolUse = res.output?.message?.content?.find((c) => "toolUse" in c)?.toolUse;
    if (!toolUse?.input) throw new Error("AI応答に期待した構造化出力が含まれていませんでした。");

    return {
      output: toolUse.input as T,
      usage: usageOf(res),
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true,
      qualityGateViolations: [],
    };
  }
}
