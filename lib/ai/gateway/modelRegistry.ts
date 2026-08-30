import type { AIQualityTier, ModelRegistryEntry } from "./types";

/**
 * §3.3 Model Registry — モデルID・価格を一元管理する(コード中に散在
 * させない)。単価はWebSearchで確認した2026-08-30時点の公開料金
 * (複数の料金比較サイトで一致: Opus 5 $5/$25、Sonnet 5 $2/$10、
 * Haiku 4.5 $1/$5、いずれも100万トークンあたりinput/output) —
 * 「モデル価格を長期間正しい前提でコードへ固定する」ことを避けるため、
 * 出典・確認日を明記し、実際のコスト計算はこの1箇所の値を参照する形
 * にして、料金改定時にここだけ更新すればよいようにしてある。
 */
export const MODEL_PRICING_VERIFIED_AT = "2026-08-30";
export const MODEL_PRICING_SOURCE = "WebSearch (複数の第三者料金比較サイトで一致確認、Anthropic公式ページへの直接到達はこのsandbox環境では不可)";

export const MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    qualityTier: "ECONOMY",
    enabled: true,
    costPerMillionInputTokensUsd: 1.0,
    costPerMillionOutputTokensUsd: 5.0,
    maxOutputTokens: 4096,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
  },
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    qualityTier: "STANDARD",
    // §17.3「現在使っているAI Providerを最初のAdapterとして動作維持
    // する」— lib/ai/ecCopy.tsが従来使っていたANTHROPIC_MODEL既定値
    // ("claude-sonnet-5")と同じモデルをSTANDARD tierの既定にすることで、
    // このGatewayへ切り替えても既存機能の出力品質は変わらない。
    enabled: true,
    costPerMillionInputTokensUsd: 2.0,
    costPerMillionOutputTokensUsd: 10.0,
    maxOutputTokens: 8192,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
  },
  {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    displayName: "Claude Opus 5",
    qualityTier: "PREMIUM",
    enabled: true,
    costPerMillionInputTokensUsd: 5.0,
    costPerMillionOutputTokensUsd: 25.0,
    maxOutputTokens: 8192,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
  },
];

/** そのtierで有効な(enabled)モデルのうちfallbackPriorityが最小のものを返す。 */
export function getModelForTier(tier: AIQualityTier): ModelRegistryEntry {
  const candidates = MODEL_REGISTRY.filter((m) => m.qualityTier === tier && m.enabled).sort((a, b) => a.fallbackPriority - b.fallbackPriority);
  if (candidates.length === 0) throw new Error(`Model Registryに${tier}向けの有効なモデルが登録されていません。`);
  return candidates[0];
}

export function getModelById(modelId: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.modelId === modelId);
}
