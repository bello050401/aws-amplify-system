import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getModelForTier, getModelById } from "./modelRegistry";
import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AITokenUsage, AIToolSchema } from "./types";

/**
 * §3.2/§17.3: 現在使っているAI Provider(Anthropic)を、まず最初の
 * Adapterとして動作維持する形でGatewayへ接続する。lib/ai/ecCopy.tsの
 * client()/describeAnthropicError()と同じロジック(意図的な複製 —
 * 同ファイルの冒頭コメント参照の理由と同じ)。
 */
function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEYが設定されていません。");
  return new Anthropic({ apiKey });
}

function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const requestId = err.requestID ? ` (request_id: ${err.requestID})` : "";
    return `Anthropic API error: ${err.message}${requestId}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const THINKING = { type: "adaptive" } as const;

export class AnthropicGatewayProvider implements AIGatewayProvider {
  readonly providerId = "anthropic";

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!process.env.ANTHROPIC_API_KEY) return { ok: false, message: "ANTHROPIC_API_KEYが未設定です。" };
    return { ok: true, message: "ANTHROPIC_API_KEYが設定されています(実際の疎通確認は行っていません — 呼び出しコストを避けるため)。" };
  }

  estimateCost(modelId: string, usage: AITokenUsage): number | null {
    const model = getModelById(modelId);
    if (!model || model.costPerMillionInputTokensUsd == null || model.costPerMillionOutputTokensUsd == null) return null;
    return (usage.inputTokens / 1_000_000) * model.costPerMillionInputTokensUsd + (usage.outputTokens / 1_000_000) * model.costPerMillionOutputTokensUsd;
  }

  async generateText(task: AITask, systemPrompt: string, userPrompt: string, policy: AIGeneratePolicy): Promise<AIGenerateResult<string>> {
    const model = getModelForTier(policy.tier);
    const startedAt = Date.now();
    let res;
    try {
      res = await client().messages.create({
        model: model.modelId,
        max_tokens: policy.maxTokens ?? model.maxOutputTokens,
        thinking: THINKING,
        output_config: { effort: "medium" },
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
    } catch (err) {
      console.error(`[AnthropicGatewayProvider.generateText] task=${task} failed:`, err);
      throw new Error(describeAnthropicError(err));
    }
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("AI応答にテキスト出力が含まれていませんでした。");

    return {
      output: textBlock.text.trim(),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId: model.modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true, // AIRouter側で上書きする(このメソッド自体は品質ゲートを知らない)
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
    const model = getModelForTier(policy.tier);
    const startedAt = Date.now();
    let res;
    try {
      res = await client().messages.create({
        model: model.modelId,
        max_tokens: policy.maxTokens ?? model.maxOutputTokens,
        thinking: THINKING,
        output_config: { effort: "medium" },
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [toolSchema],
        tool_choice: { type: "tool", name: toolSchema.name },
      });
    } catch (err) {
      console.error(`[AnthropicGatewayProvider.generateStructured] task=${task} failed:`, err);
      throw new Error(describeAnthropicError(err));
    }
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("AI応答に期待した構造化出力が含まれていませんでした。");

    return {
      output: toolUse.input as T,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId: model.modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true,
      qualityGateViolations: [],
    };
  }
}
