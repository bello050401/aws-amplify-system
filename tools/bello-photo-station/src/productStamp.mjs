import { imagePath } from './imagePath.mjs';
import sharp from 'sharp';
import { rename } from 'node:fs/promises';

const intersects = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top;

/** The verified subject coordinates refer to the leveled Lightroom JPEG. */
export function chooseStampPlacement({ width, height, sourceWidth, sourceHeight, subjectBox, crop, logoRatio = 2, logoScale = 0.29 }) {
  if (![width, height, sourceWidth, sourceHeight, logoRatio].every(n => Number.isFinite(n) && n > 0)
    || !subjectBox || ![subjectBox.left, subjectBox.top, subjectBox.width, subjectBox.height]
      .every(Number.isFinite)) return null;
  const logoWidth = Math.max(1, Math.round(Math.min(width, height) * logoScale));
  const logoHeight = Math.max(1, Math.round(logoWidth / logoRatio));
  const insetX = Math.round(width * 0.03), insetY = Math.round(width * 0.04);
  const padding = Math.round(Math.min(width, height) * 0.04);
  const box = crop ?? { left: 0, top: 0, width: sourceWidth, height: sourceHeight };
  const scale = crop ? Math.min(width / box.width, height / box.height)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const offsetX = crop ? 0 : (width - sourceWidth * scale) / 2;
  const offsetY = crop ? 0 : (height - sourceHeight * scale) / 2;
  const product = {
    left: offsetX + (subjectBox.left - box.left) * scale - padding,
    top: offsetY + (subjectBox.top - box.top) * scale - padding,
    width: subjectBox.width * scale + padding * 2,
    height: subjectBox.height * scale + padding * 2,
  };
  const positions = [
    { left: insetX, top: insetY },
    { left: width - logoWidth - insetX, top: insetY },
    { left: insetX, top: height - logoHeight - insetY },
    { left: width - logoWidth - insetX, top: height - logoHeight - insetY },
  ];
  return positions.map(pos => ({ ...pos, width: logoWidth, height: logoHeight }))
    .find(pos => pos.left >= 0 && pos.top >= 0 && !intersects(pos, product)) ?? null;
}

export async function stampProductTop({ processedPath, thumbnailPath, logoPath, geometry, jpegQuality, thumbnailJpegQuality,
  thumbnailLongEdgePx }) {
  const [photo, logo] = await Promise.all([sharp(imagePath(processedPath)).metadata(), sharp(imagePath(logoPath)).metadata()]);
  // The composition is already final. Never shrink, translate or add a band
  // to the photograph for a logo. Unknown subjects occupy the full photograph;
  // only existing contain margins may be used in that case.
  const protectedSubject = geometry.subjectBox ?? { left: 0, top: 0,
    width: geometry.sourceWidth, height: geometry.sourceHeight };
  let placement = null;
  for (const logoScale of [0.29, 0.235, 0.18, 0.12, 0.08]) {
    placement = chooseStampPlacement({ width: photo.width, height: photo.height,
      ...geometry, subjectBox: protectedSubject, logoRatio: logo.width / logo.height, logoScale });
    if (placement) break;
  }
  // Preserve the photo unchanged when all corners contain the product.
  if (!placement) return { skipped: true, reason: '商品に重ならないスタンプ位置がありません' };
  const radius = Math.max(2, Math.round(placement.height * 0.1));
  const mask = Buffer.from(`<svg width="${placement.width}" height="${placement.height}"><rect width="${placement.width}" height="${placement.height}" rx="${radius}" fill="white"/></svg>`);
  const overlay = await sharp(imagePath(logoPath)).resize({ width: placement.width, height: placement.height })
    .ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const temporary = `${processedPath}.stamping`;
  await sharp(imagePath(processedPath)).composite([{ input: overlay, left: placement.left, top: placement.top }])
    .jpeg({ quality: jpegQuality, mozjpeg: true }).toFile(imagePath(temporary));
  await rename(temporary, processedPath);
  await sharp(imagePath(processedPath)).resize({ width: thumbnailLongEdgePx, height: thumbnailLongEdgePx, fit: 'inside' })
    .jpeg({ quality: thumbnailJpegQuality, mozjpeg: true }).toFile(imagePath(`${thumbnailPath}.stamping`));
  await rename(`${thumbnailPath}.stamping`, thumbnailPath);
  return placement;
}
