import { imagePath } from './imagePath.mjs';
import sharp from "sharp";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { stampProductTop } from "./productStamp.mjs";

// Windows must be able to replace derived JPEGs on an edited retry. Keep the
// verified Lightroom disk cache, but do not retain libvips file handles.
sharp.cache({ files: 0 });

function clampPercent(value) {
  return Math.max(-100, Math.min(100, Number(value ?? 0)));
}

/**
 * Lightroom未接続時の「基本編集」。トーン補正はsharpの標準演算(modulate/
 * linear/sharpen)だけで組む。colorTemperatureShiftは本物のホワイトバランス
 * 推定ではなく、R/Bチャンネルを線形に傾けるだけの簡易近似。
 */
function applyBasicTone(pipeline, settings) {
  const brightness = clampPercent(settings.brightness);
  const saturation = clampPercent(settings.saturation);
  const contrast = clampPercent(settings.contrast);
  const temperature = clampPercent(settings.colorTemperatureShift);
  const sharpness = Math.max(0, Math.min(100, Number(settings.sharpness ?? 0)));

  let out = pipeline;
  if (brightness !== 0 || saturation !== 0) {
    out = out.modulate({ brightness: 1 + brightness / 100, saturation: 1 + saturation / 100 });
  }
  if (contrast !== 0) {
    const factor = 1 + contrast / 100;
    out = out.linear(factor, 128 * (1 - factor));
  }
  if (temperature !== 0) {
    const t = temperature / 100;
    out = out.linear([1 + t * 0.15, 1, 1 - t * 0.15], [0, 0, 0]);
  }
  if (sharpness > 0) {
    out = out.sharpen({ sigma: 0.5 + (sharpness / 100) * 2 });
  }
  return out;
}

export async function sha256File(filePath) {
  // Camera RAW files can be tens of megabytes and are hashed more than once
  // during preview, approval and upload. Stream them instead of loading the
  // entire file into memory each time.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * 1枚を「処理済みJPEG」と「サムネイルJPEG」へ書き出す。原本(sourcePath)は
 * 読み取り専用で扱い、書き込みは processedPath/thumbnailPath だけに限定する。
 * メタデータはsharpの既定動作どおり明示的に withMetadata() しない限り
 * 出力へコピーされない(=GPS・撮影者情報は自動的に削除される)。
 */
export async function processImage({ sourcePath, processedPath, thumbnailPath, settings, stamp = null }) {
  if (settings.lightroomPresetName) throw new Error('Lightroomプリセットは比較画面から選択してください。簡易処理では適用できません');
  const merged = settings;
  await mkdir(path.dirname(processedPath), { recursive: true });
  await mkdir(path.dirname(thumbnailPath), { recursive: true });

  let base = sharp(imagePath(sourcePath), { failOn: "none" });
  if (merged.autoRotate !== false) base = base.rotate();
  base = applyBasicTone(base, merged);
  if (merged.colorSpace === "srgb") base = base.toColourspace("srgb");

  // An approved product framing plan may provide a crop. Never infer one from
  // autoCrop's fixed centre position, which can cut off the product.
  if (merged.productCrop) {
    const { left, top, width, height } = merged.productCrop;
    if (![left, top, width, height].every(Number.isInteger) || left < 0 || top < 0 || width < 1 || height < 1)
      throw new Error('商品トリミング領域が不正です');
    base = base.extract({ left, top, width, height });
  }

  // Legacy plans must also fill the frame, never add background bands.
  const containRatio = merged.productContainAspectRatio;
  if (containRatio != null && containRatio !== 1 && containRatio !== 1.5)
    throw new Error('商品画像の統一比率が不正です');
  if (containRatio != null && merged.productCrop)
    throw new Error('商品画像の切り抜きと全体表示を同時に指定できません');

  const fit = merged.autoCrop && !merged.productCrop ? "cover" : "inside";
  const position = fit === "cover" ? "centre" : undefined;

  const resize = (edge) => containRatio != null
    ? { width: edge, height: Math.round(edge / containRatio), fit: 'cover', position: 'centre' }
    : { width: edge, height: edge, fit, position, withoutEnlargement: !merged.autoCrop };

  let processedPipeline = base
    .clone()
    .resize(resize(merged.longEdgePx))
    .jpeg({ quality: merged.jpegQuality, mozjpeg: true });
  if (merged.stripMetadata === false) processedPipeline = processedPipeline.withMetadata();
  const processedInfo = await processedPipeline.toFile(imagePath(processedPath));

  let thumbnailPipeline = base
    .clone()
    .resize(resize(merged.thumbnailLongEdgePx))
    .jpeg({ quality: merged.thumbnailJpegQuality, mozjpeg: true });
  if (merged.stripMetadata === false) thumbnailPipeline = thumbnailPipeline.withMetadata();
  let thumbnailInfo = await thumbnailPipeline.toFile(imagePath(thumbnailPath));

  if (stamp) await stampProductTop({ processedPath, thumbnailPath, ...stamp,
    jpegQuality: merged.jpegQuality, thumbnailJpegQuality: merged.thumbnailJpegQuality,
    thumbnailLongEdgePx: merged.thumbnailLongEdgePx });
  if (stamp) thumbnailInfo = await sharp(imagePath(thumbnailPath)).metadata();
  const [processedFile, thumbnailFile] = await Promise.all([stat(processedPath), stat(thumbnailPath)]);

  const [sourceHash, processedHash, thumbnailHash] = await Promise.all([
    sha256File(sourcePath),
    sha256File(processedPath),
    sha256File(thumbnailPath),
  ]);

  return {
    sourceHash,
    processed: {
      path: processedPath,
      width: processedInfo.width,
      height: processedInfo.height,
      size: processedFile.size,
      sha256: processedHash,
    },
    thumbnail: {
      path: thumbnailPath,
      width: thumbnailInfo.width,
      height: thumbnailInfo.height,
      size: thumbnailFile.size,
      sha256: thumbnailHash,
    },
  };
}
