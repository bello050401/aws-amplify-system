import sharp, { type Sharp } from "sharp";
import { DEFAULT_ADJUSTMENTS, shouldApplyStrongComposition } from "./pipeline";
import { analyzeImage, type ImageAnalysis, type RawImage } from "./analysis";
import { planCrop, DEFAULT_CROP_TARGETS, type CropPlan, type CropTargets, type OutputAspect } from "./cropPlanner";
import { planTone, buildToneCurve, DEFAULT_TONE_TARGETS, type TonePlan, type ToneTargets } from "./toneMap";
import type { ImageProcessingProvider, ProcessRequest, ProcessResult, ToneAdjustments } from "./types";

/**
 * lib/inventory/thumbnail.tsのTHUMBNAIL_MAX_DIMENSION(=320)と同じ値。
 * インポートせず値を重複させているのは意図的 — thumbnail.tsは
 * "server-only"かつ`next/headers`/`aws-amplify/storage/server`を
 * importするため、そこから値を1つ借りるだけでもこのファイル(Lambda
 * バンドル対象)へその依存関係ツリー全体を引きずり込んでしまう。
 */
/**
 * ProcessingJob/ImageProcessingVersionのidempotencyKey・engineVersionに使う。
 * アルゴリズムを変更したら必ず上げる(古い結果と混同しないため)。
 *
 * 2 へ更新: 構図(白帯を足すcontainリサイズ → 被写体解析にもとづくcrop)と
 * トーン(恒等変換 → 背景輝度目標・周辺減光補正・WB補正)を作り直したため、
 * version 1 の出力とは別物になる。既存のversion 1の結果は再加工の対象。
 */
export const ENGINE_VERSION = 2;

const THUMBNAIL_MAX_DIMENSION = 320;
const MASTER_JPEG_QUALITY = 90;
const WEB_WEBP_QUALITY = 82;
const MASTER_LONG_EDGE = 2000;

/** 解析はこの長辺へ縮小してから行う。構図と背景の統計にはこれで十分で、4000px級でも速い。 */
const ANALYSIS_LONG_EDGE = 640;

/**
 * BELLO画像自動加工の本体(2026-08-31 画像自動加工完全仕様書)。
 *
 * ## 何を作り直したか
 *
 * 以前の実装は実質「EXIF回転 → `fit:"contain"`でリサイズ → 再エンコード」
 * だけだった。`contain`は目標比率に合わせて**白帯を足す**ので、16:9の
 * 元画像を1:1や3:2にすると家具はむしろ小さくなる。トーン補正も
 * `DEFAULT_ADJUSTMENTS`(恒等変換)のままworkerから`{}`が渡るだけで、
 * 明るさ・WB・彩度は一切動いていなかった。
 *
 * 提示された4組のBefore/Afterを実測すると、Afterで起きているのは
 *
 *   1. 被写体の占有面積が約2倍(3.1→6.4 / 5.2→12.6 / 4.3→16.3 / 0.9→7.9 %)
 *   2. 背景輝度が大きく上昇(51〜166 → 185〜214)
 *   3. 周辺減光がほぼ解消(52〜109 → -16〜21)
 *   4. 青に寄った色かぶりの補正
 *   5. 不要な写り込み(丸テーブル右のスタジオ機材)のcropによる除外
 *
 * であり、旧実装ではどれも構造的に起こり得なかった。
 *
 * ## 現在の構成(§40 責務分離)
 *
 *   analysis.ts     … 被写体と背景の測定(ピクセルを生成しない)
 *   cropPlanner.ts  … 構図の決定(切らない・広げない・確信度が低ければ触らない)
 *   toneMap.ts      … 露出/WB/周辺減光の決定(商品色を動かさない上限つき)
 *   このファイル     … 上記の決定を1回のピクセル走査で適用し、派生画像を作る
 *
 * ## 生成しないこと
 *
 * 出力は元画像に存在する画素の色調補正・幾何補正・リサイズ・cropだけで
 * 作る。欠損の補完、傷の除去、背景の差し替え、形状の変更は一切行わない
 * (仕様§1.1)。originalは呼び出し元が保持し、ここでは読むだけである。
 */

/** 旧APIとの互換のために残しているトーン調整。手動再加工で明示的に渡されたときだけ効く。 */
function applyManualAdjustments(pipeline: Sharp, adjustments: ToneAdjustments): Sharp {
  const a = { ...DEFAULT_ADJUSTMENTS, ...adjustments };
  let p = pipeline;
  if (a.brightness !== 1.0 || a.saturation !== 1.0) {
    p = p.modulate({ brightness: a.brightness, saturation: a.saturation });
  }
  if (a.contrast !== 1.0) {
    p = p.linear(a.contrast, -(128 * a.contrast) + 128);
  }
  return p;
}

function hasManualAdjustments(adjustments: ToneAdjustments | undefined): boolean {
  if (!adjustments) return false;
  const a = { ...DEFAULT_ADJUSTMENTS, ...adjustments };
  const d = DEFAULT_ADJUSTMENTS as Record<string, number>;
  return Object.entries(a).some(([k, v]) => typeof v === "number" && v !== d[k]);
}

/** 生成したバッファが実際に再デコードできるかを検証する(§25 品質ゲート)。 */
async function verifyReadable(buffer: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buffer).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}

/** 生RAWを正規化矩形で切り出す(解析用のプレビューにだけ使う軽量版)。 */
function cropRaw(raw: RawImage, rect: { x: number; y: number; width: number; height: number }): RawImage {
  const { width, height, channels } = raw;
  const left = Math.max(0, Math.min(width - 1, Math.round(rect.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.y * height)));
  const w = Math.max(1, Math.min(width - left, Math.round(rect.width * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(rect.height * height)));
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    const srcStart = ((top + y) * width + left) * channels;
    for (let i = 0; i < w * channels; i++) out[y * w * channels + i] = raw.data[srcStart + i];
  }
  return { data: out, width: w, height: h, channels };
}

/** 解析用の縮小RAWを作る。 */
async function toAnalysisRaw(input: Sharp): Promise<RawImage> {
  const { data, info } = await input
    .clone()
    .resize({ width: ANALYSIS_LONG_EDGE, height: ANALYSIS_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * 露出・WB・周辺減光を1回の走査で適用する。
 *
 * sharpのmodulate/linear/tintを重ねる方式をやめた理由は2つ。
 * 一つは周辺減光の補正が位置依存でsharpの単純なチャンネル演算では書けないこと。
 * もう一つは、ゲインとハイライト保護を別々に掛けると壁が先に飽和してしまい、
 * 「白飛びさせずに背景だけ持ち上げる」という要求を満たせないこと。
 * LUTと半径係数を1パスで適用すれば、順序の取り違えも起きない。
 */
export function applyTonePixels(
  raw: RawImage,
  plan: TonePlan,
  backgroundReference: number,
  /**
   * このrawが元画像のどの範囲を切り出したものか(正規化座標)。
   *
   * 周辺減光はレンズの性質なので、**元フレームのどこにあった画素か**で
   * 決まる。cropした後のフレーム中心を基準にすると、実際には減光して
   * いない中央付近まで持ち上げてしまい、背景が真っ白に飛ぶ。
   * 実測で、切り出し後の座標を使ったときは白飛びが39〜63%に達した。
   */
  sourceRect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1, height: 1 },
): Buffer {
  const { width, height, channels } = raw;
  const src = raw.data;
  const out = Buffer.alloc(width * height * channels);
  const lut = buildToneCurve(plan.gain, plan.highlightKnee);
  // 周辺減光の補正は乗算で行う(光学的な減光は乗算的なので、加算で戻すと
  // 暗部だけ不自然に浮く)。元フレームの中心で1.0、隅でkだけ持ち上がる。
  const k = backgroundReference > 8 ? plan.vignetteLift / backgroundReference : 0;

  for (let y = 0; y < height; y++) {
    // 出力画素 → 元フレームの正規化座標 → 中心からの相対位置(-0.5..0.5)
    const v = sourceRect.y + ((y + 0.5) / height) * sourceRect.height - 0.5;
    for (let x = 0; x < width; x++) {
      const u = sourceRect.x + ((x + 0.5) / width) * sourceRect.width - 0.5;
      const r2 = Math.min(1, (u * u + v * v) / 0.5);
      const vig = 1 + k * r2;
      const i = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) {
        let v = src[i + c] * vig;
        if (c === 0) v *= plan.gainR;
        else if (c === 2) v *= plan.gainB;
        const idx = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
        out[i + c] = lut[idx];
      }
    }
  }
  return out;
}

export interface ProcessDiagnostics {
  analysis: ImageAnalysis;
  crop: CropPlan;
  tone: TonePlan;
  /** 加工後に測り直した被写体占有率。品質ゲートと採用判断の根拠になる。 */
  resultOccupancy: number | null;
}

export interface BelloProcessResult extends ProcessResult {
  diagnostics: ProcessDiagnostics;
}

export interface SharpProcessorOptions {
  cropTargets?: CropTargets;
  toneTargets?: ToneTargets;
}

export class SharpImageProcessingProvider implements ImageProcessingProvider {
  // パラメータプロパティ構文は使わない。型を落とすだけのランタイム
  // (node --experimental-strip-types 等)で動かせなくなり、ベンチマークを
  // ビルドなしで回せなくなるため。
  private readonly options: SharpProcessorOptions;

  constructor(options: SharpProcessorOptions = {}) {
    this.options = options;
  }

  async process(req: ProcessRequest): Promise<BelloProcessResult> {
    if (req.floorCleanupEnabled) {
      console.warn(
        "[SharpImageProcessingProvider] floorCleanupEnabled=true was requested but floor cleanup is NOT_IMPLEMENTED " +
          "(仕様§28: cropできない位置の不要物は自動生成消去せず要レビューとする). Skipping.",
      );
    }

    const cropTargets = this.options.cropTargets ?? DEFAULT_CROP_TARGETS;
    const toneTargets = this.options.toneTargets ?? DEFAULT_TONE_TARGETS;

    const rotated = sharp(req.sourceBuffer).rotate(); // EXIF orientationを正規化
    const analysisRaw = await toAnalysisRaw(rotated);

    // 被写体の検出は「露出を整えたあと」に行う(仕様§13 暗所対応)。
    //
    // 暗い写真をそのまま解析すると、商品と床のスポット光の差が小さく、
    // 尤度が全体的に低いまま横並びになる。実測では、背景輝度51の丸テーブルで
    // bbox内部の平均尤度が0.14しかなく確信度が閾値を下回り、構図を変えられな
    // かった。同じ画素でも、周辺減光とゲインを当ててから見れば差は開く。
    //
    // 露出量の推定自体は元の暗い画像から行い(そうしないと目標が決まらない)、
    // 被写体検出だけを整えた画像で行う。
    const baseAnalysis = analyzeImage(analysisRaw);
    const normalizePlan = planTone(baseAnalysis, toneTargets);
    const normalizedPreview: RawImage = {
      data: applyTonePixels(analysisRaw, normalizePlan, baseAnalysis.background.medianLuminance),
      width: analysisRaw.width,
      height: analysisRaw.height,
      channels: analysisRaw.channels,
    };
    const normalizedAnalysis = analyzeImage(normalizedPreview);

    // 背景の統計は元画像から(露出補正の目標を決めるため)、被写体は
    // 整えた画像から採る。どちらも同じ寸法なので座標系は一致する。
    const analysis: ImageAnalysis = { ...baseAnalysis, subject: normalizedAnalysis.subject };

    // DETAIL/DAMAGE/LABELは元の構図を尊重する(§6)。傷の写真を勝手に寄せない。
    const strong = shouldApplyStrongComposition(req.classification);
    const aspect: OutputAspect = strong ? (req.aspectRatio as OutputAspect) : "ORIGINAL";
    const crop = strong
      ? planCrop(analysis, aspect, cropTargets)
      : { rect: { x: 0, y: 0, width: 1, height: 1 }, applied: false, reason: "ALREADY_WELL_FRAMED" as const, resultingSubjectExtent: null, shape: "BALANCED" as const };

    const meta = await rotated.clone().metadata();
    const srcW = meta.width ?? analysis.width;
    const srcH = meta.height ?? analysis.height;

    let staged = rotated.clone();
    if (crop.applied) {
      // 丸め誤差で1pxはみ出して sharp が例外を投げないよう、必ず内側へ収める。
      const left = Math.max(0, Math.min(srcW - 1, Math.round(crop.rect.x * srcW)));
      const top = Math.max(0, Math.min(srcH - 1, Math.round(crop.rect.y * srcH)));
      const w = Math.max(1, Math.min(srcW - left, Math.round(crop.rect.width * srcW)));
      const h = Math.max(1, Math.min(srcH - top, Math.round(crop.rect.height * srcH)));
      staged = staged.extract({ left, top, width: w, height: h });
    }

    // 出力サイズ。cropで既に比率は作ってあるので、ここは縮小だけ。
    // 白帯は足さない(fit:"contain"を使わない)。
    staged = staged.resize({
      width: MASTER_LONG_EDGE,
      height: MASTER_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });

    // トーンは2段階で決める。
    //
    // 周辺減光を戻すと背景全体が明るくなるので、その前の(暗い隅を含んだ)
    // 背景輝度からゲインを計算すると二重に持ち上がって白飛びする。
    // 実測で背景が249〜255まで飛び、白飛び率が39〜63%になったのがこれ。
    // まず減光補正だけを解析用の縮小画像へ当ててcropし、その状態で
    // 背景輝度とWBを測り直してからゲインを決める。
    const vignetteOnly: TonePlan = { ...planTone(analysis, toneTargets), gain: 1, gainR: 1, gainB: 1, highlightKnee: 255 };
    const preview = applyTonePixels(analysisRaw, vignetteOnly, analysis.background.medianLuminance);
    const previewRaw: RawImage = { data: preview, width: analysisRaw.width, height: analysisRaw.height, channels: analysisRaw.channels };
    const croppedPreview = crop.applied ? cropRaw(previewRaw, crop.rect) : previewRaw;
    const correctedAnalysis = analyzeImage(croppedPreview);
    const tone: TonePlan = {
      ...planTone(correctedAnalysis, toneTargets),
      vignetteLift: vignetteOnly.vignetteLift,
    };

    const { data, info } = await staged.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const toned = applyTonePixels(
      { data, width: info.width, height: info.height, channels: info.channels },
      tone,
      analysis.background.medianLuminance,
      crop.applied ? crop.rect : { x: 0, y: 0, width: 1, height: 1 },
    );

    let processed = sharp(toned, { raw: { width: info.width, height: info.height, channels: info.channels as 3 } });
    if (hasManualAdjustments(req.adjustments)) {
      // 手動再加工で明示的に指定された分だけ、自動補正の上へ重ねる。
      processed = applyManualAdjustments(processed, req.adjustments ?? {});
    }

    const masterJpeg = await processed.clone().jpeg({ quality: MASTER_JPEG_QUALITY }).withMetadata({ exif: {} }).toBuffer();
    // §35 公開派生画像から不要EXIF(GPS等)を除去。
    const webWebp = await processed.clone().webp({ quality: WEB_WEBP_QUALITY }).toBuffer();
    const thumbnailJpeg = await sharp(masterJpeg)
      .resize({ width: THUMBNAIL_MAX_DIMENSION, height: THUMBNAIL_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();

    const outMeta = await sharp(masterJpeg).metadata();
    const [masterOk, webOk, thumbOk] = await Promise.all([
      verifyReadable(masterJpeg),
      verifyReadable(webWebp),
      verifyReadable(thumbnailJpeg),
    ]);

    // 加工後を測り直す。「本当に家具が大きくなったか」を出力側で確認する
    // ためで、crop planの見込み値をそのまま信じない。
    let resultOccupancy: number | null = null;
    try {
      const afterRaw = await toAnalysisRaw(sharp(masterJpeg));
      resultOccupancy = analyzeImage(afterRaw).subject.occupancy;
    } catch {
      resultOccupancy = null;
    }

    return {
      masterJpeg,
      webWebp,
      thumbnailJpeg,
      width: outMeta.width ?? info.width,
      height: outMeta.height ?? info.height,
      readBackVerified: masterOk && webOk && thumbOk,
      floorCleanupApplied: false,
      diagnostics: { analysis, crop, tone, resultOccupancy },
    };
  }
}
