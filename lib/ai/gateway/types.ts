/**
 * BELLO 統合業務OS ベンダー非依存・交換可能アーキテクチャ仕様書(2026-08-30)
 * §3-6: BELLO EC/メッセージ機能専用のAI Gateway共通型。
 *
 * 【既存lib/ai/(AIProvider/getAIProvider)との関係】既存のAIProviderは
 * BASE特集ページのgenerateFeatureCopy/regenerateSectionという固定2
 * メソッドに強く結合した設計であり、そのまま汎用task+policy dispatcher
 * へ拡張すると「巨大な万能Provider interface」(仕様書§20で明示的に
 * 禁止)になってしまう。そのため、こちらはBELLO EC/メッセージ専用の
 * 別の境界(lib/ai/gateway/)として新設する — lib/zaico/secretStore.ts
 * とlib/listing/mercari/secretStore.tsを意図的に別ファイルにしている
 * のと同じ、このアプリ既存の判断基準に従う(無関係な関心事を1つの
 * interfaceへ混ぜない)。既存のAIProvider/getAIProvider/
 * AnthropicProvider(BASE側)は一切変更しない。
 */

/** §3.1: BELLOが実際に使うAIタスクの種別。IMAGE_UNDERSTANDINGは「必要になった場合」のみ追加する仕様のため、現時点では未定義(将来ここへ追加する)。 */
export type AITask =
  | "LISTING_TITLE_GENERATION"
  | "LISTING_DESCRIPTION_GENERATION"
  | "CUSTOMER_REPLY_DRAFT"
  | "PRODUCT_INFORMATION_EXTRACTION"
  | "CLASSIFICATION";

/** §4: ECONOMY(安価・高速) / STANDARD(品質・価格バランス) / PREMIUM(高性能、品質ゲート不合格時のescalation先)。 */
export type AIQualityTier = "ECONOMY" | "STANDARD" | "PREMIUM";

export interface AIGeneratePolicy {
  tier: AIQualityTier;
  maxTokens?: number;
  /** §6: prompt template自体のversion — 監査ログへ記録する(prompt全文は記録しない)。 */
  promptVersion: string;
}

export interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AIGenerateResult<T> {
  output: T;
  usage: AITokenUsage;
  latencyMs: number;
  providerId: string;
  modelId: string;
  qualityTier: AIQualityTier;
  /** §4.1: escalationが発生したか(ECONOMY/STANDARDの品質ゲート不合格でPREMIUMへ再生成した場合true)。 */
  fallbackOccurred: boolean;
  /** §4.1: 品質ゲートの合否(escalationしなかった場合は初回判定の結果、escalationした場合は最終結果)。 */
  qualityGatePassed: boolean;
  qualityGateViolations: string[];
}

/** Anthropic Tool use形式(他Provider追加時もこの形へ正規化させる — providerごとのtool schema差異をGateway利用側から隠す)。 */
export interface AIToolSchema {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/** §3.2: Provider Interface。「OpenAIを呼ぶ」ではなく「このタスクをこの品質クラスで実行する」という抽象。 */
export interface AIGatewayProvider {
  readonly providerId: string;
  /** ポリシーのtierに応じたモデルで、プレーンテキストを生成する。 */
  generateText(task: AITask, systemPrompt: string, userPrompt: string, policy: AIGeneratePolicy): Promise<AIGenerateResult<string>>;
  /** ポリシーのtierに応じたモデルで、tool useによる構造化出力を生成する。 */
  generateStructured<T>(
    task: AITask,
    systemPrompt: string,
    userPrompt: string,
    toolSchema: AIToolSchema,
    policy: AIGeneratePolicy,
  ): Promise<AIGenerateResult<T>>;
  /** §3.2: healthCheck() — このProviderのAPIキー等が設定されているかどうか(実際に外部へ疎通確認するかはProvider実装に委ねる)。 */
  healthCheck(): Promise<{ ok: boolean; message: string }>;
  /** §3.2: estimateCost() — 取得可能な範囲。lib/ai/gateway/modelRegistry.tsの単価情報を使う。 */
  estimateCost(modelId: string, usage: AITokenUsage): number | null;
}

/** §3.3 Model Registry — モデルID・価格はコード中に散在させず、この1箇所で管理する。 */
export interface ModelRegistryEntry {
  providerId: string;
  modelId: string;
  displayName: string;
  qualityTier: AIQualityTier;
  enabled: boolean;
  /** USD、100万トークンあたりの概算単価(取得可能な範囲の公開情報に基づく — 為替・料金改定で変わりうるため「概算」であることを明示する)。 */
  costPerMillionInputTokensUsd: number | null;
  costPerMillionOutputTokensUsd: number | null;
  maxOutputTokens: number;
  supportsStructuredOutput: boolean;
  /** §4.1 escalation先の優先順位(小さいほど先) — PREMIUM内に複数モデルがある場合に使う。 */
  fallbackPriority: number;
}
