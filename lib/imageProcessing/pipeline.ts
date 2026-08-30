import { createHash } from "node:crypto";
import type { ImageAspectRatioName, ImageClassificationName, ImageProcessingStatusName, ToneAdjustments } from "./types";

/**
 * BELLO画像自動加工システム — AWS/Sharpに一切依存しない純粋ロジック。
 * lib/listing/pricing.ts(純粋)/pricingService.ts(AWS)や
 * lib/ai/gateway/qualityGate.ts(純粋)/usageLog.ts(AWS)と同じ、この
 * リポジトリで確立された分離原則をそのまま踏襲する — scripts/
 * verify-image-processing.tsがAWSなしでここを直接テストできる。
 */

/** 補正無し(恒等変換)の既定値。 */
export const DEFAULT_ADJUSTMENTS: Required<Pick<ToneAdjustments, "exposureEv" | "brightness" | "saturation" | "whiteBalanceTempShift" | "tint" | "contrast">> = {
  exposureEv: 0,
  brightness: 1.0,
  saturation: 1.0,
  whiteBalanceTempShift: 0,
  tint: 0,
  contrast: 1.0,
};

/** §6 の初期占有率レンジ。PhotoProfile未設定時のBELLO全体既定値(付録A「実画像から最終確定する調整値」— このラウンドでは実画像PoCが無いため指示書記載の初期値をそのまま採用し、変更しない)。 */
export const DEFAULT_OCCUPANCY_RANGE: Record<ImageAspectRatioName, { min: number; max: number }> = {
  SQUARE_1_1: { min: 0.65, max: 0.75 },
  LANDSCAPE_3_2: { min: 0.6, max: 0.7 },
};

/** §6.2 の判定を担う純粋関数。被写体セグメンテーションが無い現状(SubjectSegmentationProvider未実装)では実測occupancy/boundingBoxが得られないため、`measured`がnullの間は安全側としてLANDSCAPE_3_2(切断リスクが低い、より緩い占有率レンジ)を既定にする — 1:1を無条件既定にして家具の脚/アームが切れるリスクを負わない、という指示書§6.2「切断回避を数値目標より優先」の安全側解釈。 */
export function decideAspectRatio(measured: { occupancySquareWouldBe: number; nearEdge: boolean } | null): ImageAspectRatioName {
  if (!measured) return "LANDSCAPE_3_2";
  const range = DEFAULT_OCCUPANCY_RANGE.SQUARE_1_1;
  if (measured.nearEdge) return "LANDSCAPE_3_2";
  if (measured.occupancySquareWouldBe < range.min || measured.occupancySquareWouldBe > range.max) return "LANDSCAPE_3_2";
  return "SQUARE_1_1";
}

/** §7: TOP/FULLはBELLO標準構図を強く適用、DETAIL/DAMAGE/LABELは元構図優先(弱補正)。sharpProcessor.tsが実際にcrop/resizeの強さを決めるのに使う。 */
export function shouldApplyStrongComposition(classification: ImageClassificationName): boolean {
  return classification === "TOP" || classification === "FULL";
}

/**
 * §11.4 冪等性: 同一(storageKey, originalHash, engineVersion,
 * photoProfileVersion, triggerType)の組み合わせに対して同じキーを返す
 * 決定論的関数 — ProcessingJob.idempotencyKeyへ保存し、jobServiceが
 * 「同じ内容のジョブを重複作成しない」ために使う。手動再加工
 * (MANUAL_REPROCESS)はrequestedAdjustmentsも含めて別キーになる
 * (同じ画像でも異なる調整依頼は別ジョブとして許可する)。
 */
export function buildIdempotencyKey(input: {
  storageKey: string;
  originalHash: string;
  engineVersion: number;
  photoProfileVersion: number;
  triggerType: string;
  requestedAdjustments?: unknown;
}): string {
  const material = JSON.stringify({
    storageKey: input.storageKey,
    originalHash: input.originalHash,
    engineVersion: input.engineVersion,
    photoProfileVersion: input.photoProfileVersion,
    triggerType: input.triggerType,
    requestedAdjustments: input.requestedAdjustments ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}

/** アップロードされたバイト列のオリジナルハッシュ(originalHash) — 同一画像の重複アップロード検出、idempotencyKey算出の材料。 */
export function computeOriginalHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** §11.3 状態遷移の正当性を検証する純粋関数。scripts/verify-image-processing.tsとjobServiceの両方から呼ばれる — 「ここでしか状態遷移を定義しない」という、このリポジトリの既存の状態機械(lib/listing/status.ts等)と同じ原則。 */
const VALID_TRANSITIONS: Record<ImageProcessingStatusName, ImageProcessingStatusName[]> = {
  UNPROCESSED: ["QUEUED"],
  QUEUED: ["PROCESSING", "FAILED"], // FAILED: ジョブ登録直後にworkerがdequeueせずリース失敗した場合等
  PROCESSING: ["READY", "NEEDS_REVIEW", "FAILED"],
  READY: ["REPROCESSING", "SUPERSEDED"],
  NEEDS_REVIEW: ["REPROCESSING", "READY"], // ADMINが手動でOK扱いにできる(UI上の「そのまま採用」操作)
  FAILED: ["QUEUED", "REPROCESSING"], // リトライ
  REPROCESSING: ["READY", "NEEDS_REVIEW", "FAILED"],
  SUPERSEDED: [], // rollbackは「新しいACTIVE切替」であり、SUPERSEDED行自体の状態を書き換えるわけではない(§12: 旧versionはそのまま保持)
};

export function isValidStatusTransition(from: ImageProcessingStatusName, to: ImageProcessingStatusName): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * §17 品質ゲート(このラウンドで実装可能な範囲): 実測occupancy/
 * confidenceが無い間は「低confidence」として扱い、無条件でREADYにしな
 * い(指示書§17「低confidenceを無理にREADYへしない」を、実測値が無い
 * =confidence 0として安全側に倒す形で実装)。sharpProcessor.tsの
 * readBackVerifiedがfalseの場合も同様にNEEDS_REVIEWへ倒す。
 */
export function decideResultStatus(input: {
  readBackVerified: boolean;
  compositionConfidence: number | null; // SubjectSegmentationProvider未実装のため常にnull(=0扱い)
  confidenceThreshold: number; // PhotoProfileが持つ閾値。既定0.6
}): "READY" | "NEEDS_REVIEW" | "FAILED" {
  if (!input.readBackVerified) return "FAILED";
  const confidence = input.compositionConfidence ?? 0;
  if (confidence < input.confidenceThreshold) return "NEEDS_REVIEW";
  return "READY";
}

/** PhotoProfileの既定confidence閾値。付録A「自動READYとNEEDS_REVIEWの境界」— 実画像PoCが無いため保守的な初期値。SubjectSegmentationProvider未実装の間は実質常にNEEDS_REVIEWへ倒れる(confidenceが常に0のため)——これは意図的な安全側動作であり、バグではない。 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
