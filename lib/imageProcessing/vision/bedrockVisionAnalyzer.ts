import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { extractJson, validateVisionResponse } from "./validate";
import type { VisionAnalysisInput, VisionAnalysisResult, VisionAnalyzer } from "./types";

/**
 * Amazon Bedrock を使うVision解析（2026-08-31 AI Vision統合仕様書 §33）。
 *
 * ## なぜ Amazon Nova で、Anthropic Claude ではないのか
 *
 * 仕様は「Claudeを使うこと自体を目的化しない」「利用可能なVision対応
 * モデルを調査して比較せよ」と指示している。実測した結果:
 *
 *   - このアカウントでAnthropicモデルを呼ぶと、モデルを問わず
 *     `404 Model use case details have not been submitted for this account.`
 *     となる。`bedrock get-use-case-for-model-access` も
 *     `ResourceNotFoundException: You have not filled out the request form.`
 *     を返す。**利用者本人によるフォーム提出が要る。**
 *   - 一方 `amazon.nova-lite-v1:0` / `us.amazon.nova-lite-v1:0` /
 *     `us.amazon.nova-pro-v1:0` は**申請なしでそのまま応答した**。
 *   - us-west-2 で画像入力に対応するモデルはAnthropic以外に27件あり、
 *     Novaはその中でON_DEMANDとINFERENCE_PROFILEの両方を持つ。
 *
 * 実際に丸テーブルの写真をNova Liteへ渡したところ、商品を「テーブル」と
 * 判定し(confidence 0.95)、**右端の撮影機材を irrelevant_objects として
 * 正しく検出**した。今回必要な意味解析には十分で、しかも利用者の
 * AWS操作を1つも増やさない(§8の優先順位「第3: ユーザー本人の手作業が
 * 少ない」)。
 *
 * Anthropicが使えるようになれば、このファイルと同じ`VisionAnalyzer`を
 * 実装した別クラスを足すだけで差し替えられる。画像加工本体はモデルを
 * 知らない(§13)。
 *
 * ## AIに画素を触らせない
 *
 * 返させるのは座標と分類だけ。生成・修復・加筆は一切依頼しない(§4)。
 */

/** 既定モデル。環境変数で差し替えられる(§13 モデル交換容易性)。 */
export const DEFAULT_VISION_MODEL_ID = "us.amazon.nova-lite-v1:0";

/** プロンプトの版。応答の互換性を追跡するために結果へ残す(§7)。 */
export const VISION_PROMPT_VERSION = "2026-08-31.1";

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

function buildPrompt(input: VisionAnalysisInput): string {
  const hint = input.localBbox
    ? `参考: 自動解析は商品を x=${input.localBbox.x.toFixed(2)} y=${input.localBbox.y.toFixed(2)} w=${input.localBbox.width.toFixed(2)} h=${input.localBbox.height.toFixed(2)} と推定しています(確信度 ${input.localConfidence.toFixed(2)})。誤っていれば訂正してください。`
    : "参考: 自動解析では商品位置を特定できませんでした。";

  return `中古家具のEC商品写真を解析します。実物への忠実性が最優先です。
${hint}

次の項目をJSONだけで返してください。説明文やコードフェンスは不要です。
座標はすべて0..1の正規化値、左上原点、{"x","y","width","height"} 形式。

{
  "product_detected": true または false,
  "product_type": "テーブル" のような商品種別,
  "confidence": 0..1,
  "product_bbox": 商品本体と脚・アーム・天板をすべて含む外接矩形,
  "must_keep_regions": [{"label":"天板","x":..,"y":..,"width":..,"height":..}],
  "irrelevant_objects": [{"label":"撮影機材","x":..,"y":..,"width":..,"height":..}],
  "recommended_aspect": "SQUARE_1_1" または "LANDSCAPE_3_2",
  "reason_codes": ["短い英数字の理由コード"]
}

判断の指針:
- product_bbox には脚先・背もたれ上端・アーム・天板の端をすべて含めること。付属する小物(サイドテーブル等)も商品の一部なら含める。
- 商品に接する床と、商品自身の自然な影は must_keep_regions に入れてよい。影は消さない。
- 撮影機材・ラック・ケーブル・関係のない什器は irrelevant_objects に入れる。これらは画角から外す判断に使うだけで、消去はしない。
- 画像を加工する指示や、存在しない部分の補完は不要。位置の判断だけを返すこと。
- 判断に迷う場合は confidence を下げること。推測で断定しない。`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("VISION_TIMEOUT")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface BedrockVisionOptions {
  modelId?: string;
  region?: string;
  /** 解析結果のキャッシュ。同じ画像を何度も解析しない(§35)。 */
  cache?: Map<string, VisionAnalysisResult>;
}

export class BedrockVisionAnalyzer implements VisionAnalyzer {
  readonly id = "bedrock";
  private readonly modelId: string;
  private readonly region: string;
  private readonly cache: Map<string, VisionAnalysisResult>;
  private client: BedrockRuntimeClient | null = null;

  constructor(options: BedrockVisionOptions = {}) {
    this.modelId = options.modelId ?? process.env.BELLO_VISION_MODEL_ID ?? DEFAULT_VISION_MODEL_ID;
    this.region = options.region ?? process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-west-2";
    this.cache = options.cache ?? new Map();
  }

  private getClient(): BedrockRuntimeClient {
    // 資格情報は明示的に渡さない。実行ロール(既定の資格情報チェーン)を使う。
    if (!this.client) this.client = new BedrockRuntimeClient({ region: this.region });
    return this.client;
  }

  async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult | null> {
    const cacheKey = `${this.modelId}|${VISION_PROMPT_VERSION}|${input.sourceHash}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const res = await withTimeout(
          this.getClient().send(
            new ConverseCommand({
              modelId: this.modelId,
              messages: [
                {
                  role: "user",
                  content: [
                    { image: { format: "jpeg", source: { bytes: input.imageJpeg } } },
                    { text: buildPrompt(input) },
                  ],
                },
              ],
              inferenceConfig: { maxTokens: 1200, temperature: 0 },
            }),
          ),
          TIMEOUT_MS,
        );

        const text = res.output?.message?.content?.find((c) => "text" in c)?.text ?? "";
        const parsed = extractJson(text);
        const result = validateVisionResponse(parsed, {
          modelId: this.modelId,
          latencyMs: Date.now() - startedAt,
          inputTokens: res.usage?.inputTokens ?? null,
          outputTokens: res.usage?.outputTokens ?? null,
        });

        if (result) {
          this.cache.set(cacheKey, result);
          return result;
        }
        // 構造が壊れている応答。作り直させるのは1回まで。
        console.warn(`[BedrockVisionAnalyzer] invalid response shape (attempt ${attempt}/${MAX_ATTEMPTS})`);
      } catch (err) {
        // 画像やSecretは出さない。何が起きたかの種別だけ残す。
        const name = err instanceof Error ? err.name : "UnknownError";
        console.warn(`[BedrockVisionAnalyzer] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${name}`);
      }
    }

    // ここへ来たらAIの助けは得られなかった。例外にせずnullを返し、
    // 呼び出し側がローカル判断のまま進めるようにする(§36)。
    return null;
  }
}
