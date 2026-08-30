/**
 * BELLO画像自動加工システム(2026-08-30指示書)— ベンダー非依存の
 * Image Processing Provider境界(BELLOベンダー非依存・交換可能アーキ
 * テクチャ仕様書 §14が要求する「Image Processing provider boundaries」
 * を実際に導入する箇所)。lib/ai/gateway/types.tsと同じ設計原則:
 * 純粋な型定義のみ、AWS/Sharp/外部APIへの依存はゼロ。
 *
 * 【このラウンドで実装したもの】決定論的な加工(crop/resize/tone
 * 補正/format変換)を行う`ImageProcessingProvider`と、その唯一の実装
 * `SharpImageProcessingProvider`(sharpProcessor.ts)。
 *
 * 【このラウンドで実装しなかったもの、正直に】被写体セグメンテーション
 * (占有率の実測)・床クリーニング(inpainting)・RAW現像は、画像自動加工
 * システム指示書 §5(実画像PoCによる技術選定)を要求している —
 * このサンドボックスには実際のBELLO家具写真(理想写真群・PoC用テスト
 * セット)が一切アクセスできず(uploads配下を確認済み、実在するのは
 * この指示書自体とinventory一覧のExcelエクスポートのみで、画像ファイル
 * は含まれない)、実画像なしでcandidateアルゴリズムを比較・選定する
 * ことは指示書自身が禁止する「捏造」に当たる。したがって
 * SubjectSegmentationProvider/FloorCleanupProvider/RawDevelopmentProvider
 * のインターフェースだけをここに用意し(将来の実装がこの境界にただ
 * 差し込めるように)、実装は用意しない — SPEC_UNCONFIRMED /
 * BLOCKED_BY_USER(実画像PoC用の理想写真・テストセットの提供が必要)。
 */

export type ImageAspectRatioName = "SQUARE_1_1" | "LANDSCAPE_3_2";
export type ImageClassificationName = "TOP" | "FULL" | "DETAIL" | "DAMAGE" | "LABEL";
export type ImageProcessingStatusName =
  | "UNPROCESSED"
  | "QUEUED"
  | "PROCESSING"
  | "READY"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "REPROCESSING"
  | "SUPERSEDED";

/** §8.3 のトーン補正パラメータ。全てoptional — 未指定の項目はsharpProcessor側で無補正(恒等変換)。 */
export interface ToneAdjustments {
  exposureEv?: number; // 露出補正(EV)。sharpのlinear()へ変換
  brightness?: number; // sharp modulate()のbrightness倍率(1.0=無補正)
  saturation?: number; // sharp modulate()のsaturation倍率(1.0=無補正)
  whiteBalanceTempShift?: number; // 色温度シフト(-100〜100の相対値)。sharp tint()のr/b成分へ変換
  tint?: number; // マゼンタ/グリーン方向のシフト(-100〜100)
  contrast?: number; // sharp linear()のa係数として使用(1.0=無補正)
  highlightRecovery?: number; // 0.0〜1.0。白飛びの抑制強度(このラウンドでは未実装、値は記録のみ)
  shadowLift?: number; // 0.0〜1.0。黒潰れの持ち上げ強度(このラウンドでは未実装、値は記録のみ)
}

export interface CropRect {
  x: number; // 正規化座標(0.0〜1.0)、左上原点
  y: number;
  width: number;
  height: number;
}

export interface ProcessRequest {
  /** 加工対象のオリジナル画像バイト列。 */
  sourceBuffer: Buffer;
  /** §6 の構図判定に使う分類。TOP/FULLはBELLO標準構図を強く適用、DETAIL/DAMAGE/LABELは元構図優先(弱補正)。 */
  classification: ImageClassificationName;
  /** 呼び出し元(jobService)が既に決定したアスペクト比。sharpProcessor自身は被写体セグメンテーションを持たないため決定はできず、常に呼び出し元から受け取る(§14.2「アルゴリズムをprovider内に隠さない」)。 */
  aspectRatio: ImageAspectRatioName;
  /** 手動再加工(§12)時のみユーザー指定値で上書き。指定が無い項目はBELLO既定値(pipeline.tsのDEFAULT_ADJUSTMENTS)。 */
  adjustments?: ToneAdjustments;
  floorCleanupEnabled?: boolean;
  floorCleanupStrength?: number; // 0.0〜1.0
}

export interface ProcessResult {
  /** 高品質JPEGマスター。 */
  masterJpeg: Buffer;
  /** EC表示用WebP派生。 */
  webWebp: Buffer;
  /** 一覧用サムネイル(thumbnail.tsのTHUMBNAIL_MAX_DIMENSIONと同じ規格)。 */
  thumbnailJpeg: Buffer;
  width: number;
  height: number;
  /** §17 品質ゲート: 実際に生成した各バッファをsharpで読み戻し、破損していないことを検証済みか。falseなら呼び出し元はREADYにしてはならない。 */
  readBackVerified: boolean;
  /**
   * §9(床クリーニング)は実装していないため、floorCleanupEnabledが
   * trueで渡されても常にfalseを返す — 「対応していない機能を対応した
   * ふりで返さない」ため、呼び出し元は必ずこれをチェックしてログへ
   * 残すこと(NOT_IMPLEMENTEDの明示、fake success禁止の原則)。
   */
  floorCleanupApplied: false;
}

/**
 * 決定論的な画像加工処理の境界。実装差し替え可能(将来ECS/Fargateベース
 * の重い処理へ移行する場合も、この関数シグネチャを満たす別実装を
 * jobServiceへ差し込むだけで済む — Strangler Pattern、大規模書き換え
 * 不要)。
 */
export interface ImageProcessingProvider {
  process(req: ProcessRequest): Promise<ProcessResult>;
}

/**
 * §5 実画像PoCが必要な、未実装のProvider境界(インターフェースのみ)。
 * 実装はSPEC_UNCONFIRMED — 実画像テストセットが無いためこのラウンドで
 * は着手しない。
 */
export interface SubjectSegmentationProvider {
  /** 被写体のbounding box・占有率・safe marginsを実測する。 */
  detectSubject(imageBuffer: Buffer): Promise<{
    boundingBox: CropRect;
    occupancy: number;
    confidence: number; // 0.0〜1.0。閾値未満はNEEDS_REVIEWへ(§17)
  }>;
}

export interface FloorCleanupProvider {
  /** 商品領域を保護マスクした上で床の傷・汚れを除去する(§9)。 */
  cleanFloor(imageBuffer: Buffer, subjectMask: CropRect): Promise<{ resultBuffer: Buffer; confidence: number }>;
}

export interface RawDevelopmentProvider {
  /** RAW(CR2/NEF/ARW等)を高品質JPEGへ現像する(§10)。 */
  develop(rawBuffer: Buffer, format: string): Promise<Buffer>;
}

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §12.8: 「画像を自動加工」一括ボタン(商品単位:
 * app/inventory/ImageProcessingPanel.tsx、複数商品横断:
 * app/actions/imageProcessing.tsのbulkReprocessInventoryImagesAction)
 * の両方が対象とする画像のversion状態——既にREADYの画像は巻き込まない
 * (付録B「再加工で全画像を巻き込む処理」の禁止と同じ理由)。"use
 * client"ファイルと"use server"ファイルの両方から安全にimportできる
 * よう、どちらの境界も持たないこの中立なtypes.tsへ置く。
 */
export const BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES = ["UNPROCESSED", "FAILED", "DEAD_LETTER", "NEEDS_REVIEW"] as const;
