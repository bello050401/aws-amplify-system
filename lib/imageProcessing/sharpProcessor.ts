import sharp, { type Sharp } from "sharp";
import { DEFAULT_ADJUSTMENTS, shouldApplyStrongComposition } from "./pipeline";
import type { ImageProcessingProvider, ProcessRequest, ProcessResult, ToneAdjustments } from "./types";

/**
 * lib/inventory/thumbnail.tsのTHUMBNAIL_MAX_DIMENSION(=320)と同じ値。
 * インポートせず値を重複させているのは意図的 — thumbnail.tsは
 * "server-only"かつ`next/headers`/`aws-amplify/storage/server`を
 * importするため、そこから値を1つ借りるだけでもこのファイル(Lambda
 * バンドル対象、かつpure importとしてテストしたい)へその依存関係
 * ツリー全体を引きずり込んでしまう——lib/zaico/secretStore.ts vs
 * lib/listing/mercari/secretStore.tsで確立した「境界の異なる小さな
 * 重複は、誤った密結合より安全」という既存の方針をここでも踏襲する。
 */
const THUMBNAIL_MAX_DIMENSION = 320;

/**
 * BELLO画像自動加工システムの唯一の実装済みProvider — 決定論的な
 * crop/resize/tone補正/format変換のみ(§22「決定論的処理を中心に」)。
 * lib/inventory/thumbnail.tsと同じ`sharp`パッケージを再利用(新規依存
 * 追加なし)、bundling互換性は既にamplify/functions/pricing-scheduler
 * で確立済みのパターン(server-only指定の無い純粋なlib/配下モジュール
 * はLambdaへ安全にバンドルできる)をそのまま踏襲する。
 *
 * このバージョン番号はProcessingJob/ImageProcessingVersionの
 * idempotencyKey・engineVersionに使う — アルゴリズムを変更したら必ず
 * 上げる(古いバージョンの結果と混同しないため)。
 */
export const ENGINE_VERSION = 1;

const MASTER_JPEG_QUALITY = 92;
const WEB_WEBP_QUALITY = 80;

/**
 * §6.2/§9の安全境界: 実際の被写体segmentationが無い(types.tsの
 * SubjectSegmentationProviderは未実装)ため、目標アスペクト比へ
 * "cover"(切り抜き)ではなく"contain"(全体を収め、余白を足す)で合わせる
 * — 指示書§6.1「脚、アーム、オットマン、背もたれ等の切断回避を数値
 * 目標より優先する」を、実測データが無い状況でも構造的に破らない
 * ための意図的な安全側実装。占有率の数値目標(§6の1:1 65〜75%等)は
 * 実際のBELLO家具写真の構図に近ければ自然に満たされるが、極端な
 * 縦長・横長写真では満たされないことがある——これは実画像PoC
 * (SPEC_UNCONFIRMED、このラウンドでは未実施)で調整すべき既知の限界と
 * して残す。
 */
function targetDimensions(aspectRatio: "SQUARE_1_1" | "LANDSCAPE_3_2", longEdge: number): { width: number; height: number } {
  if (aspectRatio === "SQUARE_1_1") return { width: longEdge, height: longEdge };
  return { width: longEdge, height: Math.round((longEdge * 2) / 3) };
}

/** §8.3 補正パラメータをsharpのAPI呼び出しへ変換する。全てDEFAULT_ADJUSTMENTS(恒等変換)なら何もしない — 無駄な再エンコードのコスト増を避ける(§19コスト最適化の一環)。 */
function applyToneAdjustments(pipeline: Sharp, adjustments: ToneAdjustments): Sharp {
  const a = { ...DEFAULT_ADJUSTMENTS, ...adjustments };
  let p = pipeline;
  if (a.brightness !== 1.0 || a.saturation !== 1.0) {
    p = p.modulate({ brightness: a.brightness, saturation: a.saturation });
  }
  if (a.exposureEv !== 0) {
    // 簡易的な露出補正: 1EV = ×2の輝度。linear(a, b)はoutput = input*a + b。
    p = p.linear(Math.pow(2, a.exposureEv), 0);
  }
  if (a.contrast !== 1.0) {
    // コントラスト: 中間灰色(128)を軸に伸縮。
    p = p.linear(a.contrast, -(128 * a.contrast) + 128);
  }
  if (a.whiteBalanceTempShift !== 0 || a.tint !== 0) {
    // 色温度シフトを簡易的にR/Bチャンネルの相対シフトとして表現。
    // 正式なWB推定(グレーワールド法等)は実画像PoCで検証すべき項目
    // (付録A)——ここではPhotoProfileや手動再加工から明示的に数値を
    // 渡された場合のみ効く、決定論的で副作用の小さい実装に留める。
    const rShift = Math.round((a.whiteBalanceTempShift / 100) * 30);
    const bShift = Math.round((-a.whiteBalanceTempShift / 100) * 30 + (a.tint / 100) * 20);
    p = p.tint({ r: 255 + rShift, g: 255, b: 255 + bShift });
  }
  return p;
}

/** 生成したバッファが実際に再デコードできるかを検証する(§17品質ゲート「生成後のJPEG/WebP等を読み戻せる」)。破損していれば例外ではなくfalseを返す — 呼び出し元がFAILED/NEEDS_REVIEWへ倒す判断に使う。 */
async function verifyReadable(buffer: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buffer).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}

export class SharpImageProcessingProvider implements ImageProcessingProvider {
  async process(req: ProcessRequest): Promise<ProcessResult> {
    if (req.floorCleanupEnabled) {
      // §9 床クリーニングは未実装(types.tsのFloorCleanupProvider参照)。
      // 「対応したふり」をしない——実施しなかった旨を必ずログへ残す。
      console.warn(
        "[SharpImageProcessingProvider] floorCleanupEnabled=true was requested but floor cleanup is NOT_IMPLEMENTED " +
          "(requires real-image PoC per 画像自動加工システム指示書 §5/§9 — not available in this environment). Skipping floor cleanup; image processed without it.",
      );
    }

    const strong = shouldApplyStrongComposition(req.classification);
    const longEdge = 2000; // マスター画像の長辺(px)。理想写真基準が未確定(PhotoProfile PoC待ち)のため、既存thumbnail.ts同様の保守的な固定値。
    const { width, height } = strong
      ? targetDimensions(req.aspectRatio, longEdge)
      : { width: longEdge, height: longEdge }; // DETAIL/DAMAGE/LABELはBELLO標準構図を強制しない(§7)— 元画像のアスペクト比を維持("contain"は下記base変換で共通)

    const base = sharp(req.sourceBuffer).rotate(); // EXIF orientationを適用(thumbnail.tsと同じ理由)
    const composed = strong
      ? base.resize({ width, height, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 }, withoutEnlargement: true })
      : base.resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });

    const toned = applyToneAdjustments(composed.clone(), req.adjustments ?? {});

    const masterJpeg = await toned.clone().jpeg({ quality: MASTER_JPEG_QUALITY }).withMetadata({ exif: {} }).toBuffer();
    // §21 セキュリティ: 公開派生画像(WebP/thumbnail)から不要EXIF(位置情報等)を除去。
    // withMetadata({exif:{}})でEXIFブロックを空にする — sharpのデフォルト(withMetadataを
    // 呼ばない場合)はEXIFを破棄するが、明示しておくことで意図を残す。
    const webWebp = await toned.clone().webp({ quality: WEB_WEBP_QUALITY }).toBuffer();
    const thumbnailJpeg = await sharp(masterJpeg)
      .resize({ width: THUMBNAIL_MAX_DIMENSION, height: THUMBNAIL_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();

    const meta = await sharp(masterJpeg).metadata();
    const [masterOk, webOk, thumbOk] = await Promise.all([verifyReadable(masterJpeg), verifyReadable(webWebp), verifyReadable(thumbnailJpeg)]);

    return {
      masterJpeg,
      webWebp,
      thumbnailJpeg,
      width: meta.width ?? width,
      height: meta.height ?? height,
      readBackVerified: masterOk && webOk && thumbOk,
      floorCleanupApplied: false,
    };
  }
}
