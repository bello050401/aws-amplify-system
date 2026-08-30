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

/**
 * 夜間長時間・全課題解決指示書 §6: Amazon Bedrock経由で同じモデル群を
 * 使うためのレジストリ。Anthropic直APIとはモデルIDの綴りが異なる
 * (Bedrockは`anthropic.`接頭辞つき、クロスリージョン推論プロファイルは
 * さらに`us.`接頭辞つき)ため、上のMODEL_REGISTRYとは別表にしてある —
 * どちらのProviderでもモデルIDをコード中へ散在させない、という方針は
 * 同じ(§6-6)。
 *
 * 単価について: Bedrock経由のClaudeは**AWSが販売するパートナー提供**で
 * あり、Anthropic直APIの料金とは別建て。ここに置いた値はAnthropic直の
 * 公開単価と同額を暫定値として使っているが、AWS側の実請求と一致する
 * 保証はない(「無料」と断定できる根拠はこのアカウントでは確認できて
 * いない — 指示書§6-4「『無料』を架空に断定しない」)。コスト表示は
 * あくまで概算であり、正確な費用はAWSの請求で確認する必要がある。
 *
 * 既定のモデル選択は`BEDROCK_MODEL_ECONOMY`等の環境変数で上書きできる
 * (§6-6「configurableにする」)。
 */
export const BEDROCK_MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    providerId: "bedrock",
    // ここに並ぶIDは全て`bedrock list-inference-profiles`に実在し、かつ
    // このアカウントから実際にmessages.createが通ることを1件ずつ実測
    // 確認したものだけ。素のON_DEMANDモデルIDでは呼べず、必ず`us.`付き
    // のクロスリージョン推論プロファイルを使う。
    //
    // 実測で除外したもの(推測ではなく実際のAPI応答):
    //   claude-sonnet-5 / opus-5 / fable-5 … 403「not available for this account」
    //   claude-3-haiku / claude-3-sonnet   … 404「marked by provider as Legacy」
    //   claude-haiku-4-5                   … 404(用途フォーム提出前は最初から不可)
    // Haikuが使えれば単価は約1/3になるため、フォーム提出後に
    // BEDROCK_MODEL_ECONOMY で切り替えられるようにしてある。
    modelId: process.env.BEDROCK_MODEL_ECONOMY || "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    displayName: "Claude Sonnet 4.5 (Bedrock)",
    qualityTier: "ECONOMY",
    enabled: true,
    costPerMillionInputTokensUsd: 3.0,
    costPerMillionOutputTokensUsd: 15.0,
    maxOutputTokens: 8192,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
    // 4.5系はadaptive thinking非対応(4.6以降のみ)。
    supportsAdaptiveThinking: false,
  },
  {
    providerId: "bedrock",
    modelId: process.env.BEDROCK_MODEL_STANDARD || "us.anthropic.claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Bedrock)",
    qualityTier: "STANDARD",
    enabled: true,
    costPerMillionInputTokensUsd: 3.0,
    costPerMillionOutputTokensUsd: 15.0,
    maxOutputTokens: 8192,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
    supportsAdaptiveThinking: true,
  },
  {
    providerId: "bedrock",
    modelId: process.env.BEDROCK_MODEL_PREMIUM || "us.anthropic.claude-opus-4-5-20251101-v1:0",
    displayName: "Claude Opus 4.5 (Bedrock)",
    qualityTier: "PREMIUM",
    enabled: true,
    costPerMillionInputTokensUsd: 5.0,
    costPerMillionOutputTokensUsd: 25.0,
    maxOutputTokens: 8192,
    supportsStructuredOutput: true,
    fallbackPriority: 1,
    supportsAdaptiveThinking: false,
  },
];


export function getBedrockModelForTier(tier: AIQualityTier): ModelRegistryEntry {
  const candidates = BEDROCK_MODEL_REGISTRY.filter((m) => m.qualityTier === tier && m.enabled).sort((a, b) => a.fallbackPriority - b.fallbackPriority);
  if (candidates.length === 0) throw new Error(`Bedrock Model Registryに${tier}向けの有効なモデルが登録されていません。`);
  return candidates[0];
}

export function getBedrockModelById(modelId: string): ModelRegistryEntry | undefined {
  return BEDROCK_MODEL_REGISTRY.find((m) => m.modelId === modelId);
}
