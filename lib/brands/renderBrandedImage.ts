import sharp from "sharp";

/** Render only; the caller decides whether to save the result. */
export async function renderBrandedImage(
  photo: Buffer,
  logos: { bello: Buffer; productBrand?: Buffer | null },
): Promise<Buffer> {
  const base = await sharp(photo).rotate().jpeg({ quality: 90 }).toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width!; const height = metadata.height!;
  const inset = Math.round(Math.min(width, height) * 0.025);
  const widthLimit = Math.round(Math.min(width, height) * 0.22);
  const bello = await sharp(logos.bello).rotate().resize({ width: widthLimit, height: widthLimit, fit: "inside" }).png().toBuffer();
  const overlays: { input: Buffer; left: number; top: number }[] = [{ input: bello, left: inset, top: inset }];
  if (logos.productBrand) {
    const brand = await sharp(logos.productBrand).rotate().resize({ width: widthLimit, height: Math.round(widthLimit * 0.52), fit: "inside" }).png().toBuffer();
    const brandSize = await sharp(brand).metadata();
    overlays.push({ input: brand, left: width - brandSize.width! - inset, top: height - brandSize.height! - inset });
  }
  // Both marks are inside the original photo; no canvas space or badge background is added.
  return sharp(base).composite(overlays).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
