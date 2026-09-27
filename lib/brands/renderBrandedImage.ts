import sharp from "sharp";
import { hasClearLogoCorner } from "./logoPlacement";

/** Render only; the caller decides whether to save the result. */
export async function renderBrandedImage(photo: Buffer, logo: Buffer): Promise<Buffer> {
  const base = await sharp(photo).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width!; const height = metadata.height!;
  const badgeWidth = Math.round(Math.min(width, height) * 0.22);
  const badgeHeight = Math.round(badgeWidth * 0.52);
  const inset = Math.round(Math.min(width, height) * 0.025);
  const left = width - badgeWidth - inset; let top = height - badgeHeight - inset;
  const cornerBytes = await sharp(base).extract({ left, top, width: badgeWidth, height: badgeHeight }).toBuffer();
  const corner = await sharp(cornerBytes).stats();
  const needsFooter = !hasClearLogoCorner(corner);
  if (needsFooter) top = height + inset;
  const badge = await sharp({ create: { width: badgeWidth, height: badgeHeight, channels: 4, background: "#ffffffee" } })
    .composite([{ input: await sharp(logo).resize({ width: Math.round(badgeWidth * 0.88), height: Math.round(badgeHeight * 0.86), fit: "inside" }).png().toBuffer(), gravity: "centre" }])
    .png().toBuffer();
  const canvas = needsFooter
    ? await sharp(base).extend({ bottom: badgeHeight + inset * 2, background: "#ffffff" }).toBuffer()
    : base;
  return sharp(canvas).composite([{ input: badge, left, top }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
