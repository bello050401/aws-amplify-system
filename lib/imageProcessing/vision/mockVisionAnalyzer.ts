import { extractJson, validateVisionResponse } from "./validate";
import type { VisionAnalysisInput, VisionAnalysisResult, VisionAnalyzer } from "./types";

/**
 * テスト用のVision解析（2026-08-31 AI Vision統合仕様書 §14 / §46）。
 *
 * CIで毎回課金しないため、固定応答を返す実装を用意する。実装と同じ
 * `extractJson` → `validateVisionResponse` の経路を通すので、
 * 検証層のふるまいごと確認できる。
 *
 * **モックが通ることは実機検証ではない。** 報告では MOCK VERIFIED と
 * REAL MODEL VERIFIED を必ず区別すること(§14)。
 */
export class MockVisionAnalyzer implements VisionAnalyzer {
  readonly id = "mock";
  /** 呼ばれた回数。ルーティングが本当に難例だけで呼んでいるかの確認に使う。 */
  calls = 0;
  lastInput: VisionAnalysisInput | null = null;

  constructor(
    /** モデルが返すはずの生テキスト。壊れたJSONやタイムアウトも再現できる。 */
    private readonly responder: (input: VisionAnalysisInput) => string | Error | null,
    private readonly modelId = "mock-vision",
  ) {}

  async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult | null> {
    this.calls++;
    this.lastInput = input;
    const raw = this.responder(input);
    if (raw === null) return null;          // AI利用不可を再現
    if (raw instanceof Error) return null;  // 実装と同じく例外は握って null
    const parsed = extractJson(raw);
    return validateVisionResponse(parsed, { modelId: this.modelId, latencyMs: 1, inputTokens: 100, outputTokens: 50 });
  }
}

/** 実機で観測した丸テーブルの応答（撮影機材を検出できた実例）。 */
export const ROUND_TABLE_FIXTURE = JSON.stringify({
  product_detected: true,
  product_type: "テーブル",
  confidence: 0.95,
  product_bbox: { x: 0.4, y: 0.31, width: 0.28, height: 0.46 },
  must_keep_regions: [{ label: "天板/脚/影", x: 0.4, y: 0.31, width: 0.28, height: 0.46 }],
  irrelevant_objects: [{ label: "撮影機材", x: 0.84, y: 0.19, width: 0.16, height: 0.37 }],
  recommended_aspect: "SQUARE_1_1",
  reason_codes: ["product_central", "shadow_included", "no_cut_product"],
});

/** AIの助けが得られないことを表す解析器（機能を無効化したいとき）。 */
export class NullVisionAnalyzer implements VisionAnalyzer {
  readonly id = "disabled";
  async analyze(): Promise<null> {
    return null;
  }
}
