"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import sharp from "sharp";
import { getUrl, uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { findBrandByName } from "@/lib/brands/catalog";
import { hasClearLogoCorner } from "@/lib/brands/logoPlacement";

async function ownImage(path: string): Promise<Buffer> {
  const { url } = await runWithAmplifyServerContext({ nextServerContext: { cookies },
    operation: (context) => getUrl(context, { path, options: { expiresIn: 120 } }) });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("画像を取得できませんでした。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25_000_000) throw new Error("画像が大きすぎます。");
  return bytes;
}

async function saveImage(path: string, bytes: Buffer, contentType: string): Promise<void> {
  await runWithAmplifyServerContext({ nextServerContext: { cookies },
    operation: (context) => uploadData(context, { path, data: bytes,
      options: { contentType, cacheControl: "private, max-age=31536000, immutable" } }).result });
}

/** Called only by an explicit opt-in on the EC listing screen. The original photo stays intact. */
export async function createBrandedListingImageAction(inventoryId: string): Promise<{ storageKey: string }> {
  if (!canEditInventory(await getInventoryRole())) throw new Error("画像を編集する権限がありません。");
  const item = await getInventoryDetail(inventoryId);
  if (!item) throw new Error("商品が見つかりません。");
  const selectedName = typeof item.customFields?.belloBrand === "string" ? item.customFields.belloBrand : "";
  const brand = findBrandByName(selectedName);
  if (!brand?.logoUrl) throw new Error("ブランドとロゴを商品編集画面で選んでください。");
  const logoUrl = new URL(brand.logoUrl);
  if (logoUrl.protocol !== "https:" || !["img.tabroom.jp", "dopa.co.jp", "www.dopa.co.jp"].includes(logoUrl.hostname))
    throw new Error("このブランドのロゴURLは利用できません。");

  const top = item.images.find((image) => image.type === "NORMAL" && image.isPrimary)
    ?? item.images.find((image) => image.type === "NORMAL");
  if (!top) throw new Error("トップ画像がありません。");
  const photo = await ownImage(top.storageKey);
  const logoKey = `inventory/brand-logos/${brand.id}.png`;
  let logo: Buffer;
  try { logo = await ownImage(logoKey); }
  catch {
    const response = await fetch(logoUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
    const mime = (response.headers.get("content-type") ?? "").split(";")[0];
    if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("ブランドロゴを取得できませんでした。");
    const source = Buffer.from(await response.arrayBuffer());
    if (source.length > 2_000_000) throw new Error("ブランドロゴが大きすぎます。");
    logo = await sharp(source).resize({ width: 600, height: 300, fit: "inside" }).png().toBuffer();
    await saveImage(logoKey, logo, "image/png");
  }

  const base = await sharp(photo).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width!; const height = metadata.height!;
  const badgeWidth = Math.round(Math.min(width, height) * 0.22);
  const badgeHeight = Math.round(badgeWidth * 0.52);
  const inset = Math.round(Math.min(width, height) * 0.025);
  const left = width - badgeWidth - inset; const topPos = height - badgeHeight - inset;
  // A quiet dark/product-colored corner is still unsafe. Require a nearly
  // white and low-detail background, then ask the editor to review the preview.
  const corner = await sharp(base).extract({ left, top: topPos, width: badgeWidth, height: badgeHeight }).stats();
  if (!hasClearLogoCorner(corner))
    throw new Error("右下に商品が写っている可能性があります。ロゴを重ねずに停止しました。");
  const badge = await sharp({ create: { width: badgeWidth, height: badgeHeight, channels: 4, background: "#ffffffee" } })
    .composite([{ input: await sharp(logo).resize({ width: Math.round(badgeWidth * 0.88), height: Math.round(badgeHeight * 0.86), fit: "inside" }).png().toBuffer(), gravity: "centre" }])
    .png().toBuffer();
  const result = await sharp(base).composite([{ input: badge, left, top: topPos }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const storageKey = `inventory/listing-branded/${randomUUID()}.jpg`;
  await saveImage(storageKey, result, "image/jpeg");
  return { storageKey };
}
