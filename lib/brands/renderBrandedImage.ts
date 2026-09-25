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
  const left = width - badgeWidth - inset; const top = height - badgeHeight - inset;
  const cornerBytes = await sharp(base).extract({ left, top, width: badgeWidth, height: badgeHeight }).toBuffer();
  const corner = await sharp(cornerBytes).stats();
  if (!hasClearLogoCorner(corner))
    throw new Error("右下に商品が写っている可能性があります。ロゴを重ねずに停止しました。");
  const badge = await sharp({ create: { width: badgeWidth, height: badgeHeight, channels: 4, background: "#ffffffee" } })
    .composite([{ input: await sharp(logo).resize({ width: Math.round(badgeWidth * 0.88), height: Math.round(badgeHeight * 0.86), fit: "inside" }).png().toBuffer(), gravity: "centre" }])
    .png().toBuffer();
  return sharp(base).composite([{ input: badge, left, top }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
