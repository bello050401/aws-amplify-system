/**
 * AI Vision の境界（2026-08-31 AI Vision統合仕様書 §13）。
 *
 * 画像加工本体を特定モデルへ密結合させないための型だけの層。
 * ここにはAWSもモデル名も出てこない。実装は
 * `bedrockVisionAnalyzer.ts` / `mockVisionAnalyzer.ts` が差し込む。
 *
 * ## AIの位置づけ
 *
 * AIは**判断役**であって実行役ではない（§2）。返ってくるのは
 * 「商品はここ」「これは撮影機材」といった意味情報だけで、画素は
 * 一切AIに触らせない。傷を消す、木目を作る、背景を差し替えるといった
 * 生成は行わない（§4）。
 *
 * ## 全画像に使わない
 *
 * ローカル解析の確信度が十分なら呼ばない（§5、§35）。実際、暗所の
 * 丸テーブルは「露出を整えてから検出する」という順序変更だけで
 * 占有率2.3%→8.6%（お手本9.9%）まで改善し、撮影機材の除外も
 * できている。AIはそれでも決めきれない難例のための補助である。
 */

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabeledRect extends NormalizedRect {
  label: string;
}

/** なぜAIを呼ぶことにしたか。観測とコスト分析のために型で持つ（§49）。 */
export type VisionTriggerReason =
  | "LOW_LOCAL_CONFIDENCE"
  | "NO_LOCAL_SUBJECT"
  | "SUSPECTED_IRRELEVANT_OBJECT"
  | "DARK_SCENE"
  | "WHITE_ON_WHITE"
  | "MANUAL_REQUEST";

export interface VisionAnalysisInput {
  /** 解析用に縮小したJPEG。細い脚や金属の輪郭が消えるほど小さくしない（§37）。 */
  imageJpeg: Buffer;
  /** 縮小後の寸法。AIが返す正規化座標を検証するのに使う。 */
  imageWidth: number;
  imageHeight: number;
  /** ローカル解析が出した候補。AIへの手がかりとして渡す（§6）。 */
  localBbox: NormalizedRect | null;
  localConfidence: number;
  /** 冪等・キャッシュのためのキー。同じ画像を何度も解析しない（§35）。 */
  sourceHash: string;
  trigger: VisionTriggerReason;
}

export interface VisionAnalysisResult {
  productDetected: boolean;
  productType: string | null;
  /** AI自身が申告する確信度（0..1）。検証後に呼び出し側が再評価する。 */
  confidence: number;
  productBbox: NormalizedRect | null;
  /** 切ってはいけない領域（天板・脚・影など）。 */
  mustKeepRegions: LabeledRect[];
  /** 画角から外したい不要物（撮影機材など）。**消すのではなくcropで外す**（§5）。 */
  irrelevantObjects: LabeledRect[];
  recommendedAspect: "SQUARE_1_1" | "LANDSCAPE_3_2" | null;
  reasonCodes: string[];
  /** 観測用。どのモデルがどれだけ掛かったか（§49、§65）。 */
  modelId: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * 差し替え可能なVision解析。
 *
 * 失敗時は例外を投げるのではなく `null` を返す。AIが落ちても画像加工
 * 全体を止めないため（§36「AI障害でシステム全体を停止させない」）。
 * 呼び出し側は null を「AIの助けは得られなかった」として扱い、
 * ローカルの判断のまま進むか NEEDS_REVIEW にする。
 */
export interface VisionAnalyzer {
  readonly id: string;
  analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult | null>;
}
