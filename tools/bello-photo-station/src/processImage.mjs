import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

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
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 1枚を「処理済みJPEG」と「サムネイルJPEG」へ書き出す。原本(sourcePath)は
 * 読み取り専用で扱い、書き込みは processedPath/thumbnailPath だけに限定する。
 * メタデータはsharpの既定動作どおり明示的に withMetadata() しない限り
 * 出力へコピーされない(=GPS・撮影者情報は自動的に削除される)。
 */
export async function processImage({ sourcePath, processedPath, thumbnailPath, settings }) {
  const merged = settings;
  await mkdir(path.dirname(processedPath), { recursive: true });
  await mkdir(path.dirname(thumbnailPath), { recursive: true });

  let base = sharp(sourcePath, { failOn: "none" });
  if (merged.autoRotate !== false) base = base.rotate();
  base = applyBasicTone(base, merged);
  if (merged.colorSpace === "srgb") base = base.toColourspace("srgb");

  const fit = merged.autoCrop ? "cover" : "inside";
  const position = merged.autoCrop ? "centre" : undefined;

  let processedPipeline = base
    .clone()
    .resize({ width: merged.longEdgePx, height: merged.longEdgePx, fit, position, withoutEnlargement: !merged.autoCrop })
    .jpeg({ quality: merged.jpegQuality, mozjpeg: true });
  if (merged.stripMetadata === false) processedPipeline = processedPipeline.withMetadata();
  const processedInfo = await processedPipeline.toFile(processedPath);

  let thumbnailPipeline = base
    .clone()
    .resize({ width: merged.thumbnailLongEdgePx, height: merged.thumbnailLongEdgePx, fit, position, withoutEnlargement: !merged.autoCrop })
    .jpeg({ quality: merged.thumbnailJpegQuality, mozjpeg: true });
  if (merged.stripMetadata === false) thumbnailPipeline = thumbnailPipeline.withMetadata();
  const thumbnailInfo = await thumbnailPipeline.toFile(thumbnailPath);

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
      size: processedInfo.size,
      sha256: processedHash,
    },
    thumbnail: {
      path: thumbnailPath,
      width: thumbnailInfo.width,
      height: thumbnailInfo.height,
      size: thumbnailInfo.size,
      sha256: thumbnailHash,
    },
  };
}
