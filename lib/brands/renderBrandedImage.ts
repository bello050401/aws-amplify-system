import sharp from "sharp";

/** Render only; the caller decides whether to save the result. */
export async function renderBrandedImage(photo: Buffer, logo: Buffer): Promise<Buffer> {
  const base = await sharp(photo).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width!; const height = metadata.height!;
  const badgeWidth = Math.round(Math.min(width, height) * 0.22);
  const badgeHeight = Math.round(badgeWidth * 0.52);
  const inset = Math.round(Math.min(width, height) * 0.025);
  // The operator requested an overlay inside the photo, without an added footer or badge background.
  const badge = await sharp(logo).rotate().resize({ width: badgeWidth, height: badgeHeight, fit: "inside" }).png().toBuffer();
  const logoSize = await sharp(badge).metadata();
  const left = width - logoSize.width! - inset;
  const top = height - logoSize.height! - inset;
  return sharp(base).composite([{ input: badge, left, top }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
