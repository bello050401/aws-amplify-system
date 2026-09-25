"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import sharp from "sharp";
import { getUrl, uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { findBrandByName } from "@/lib/brands/catalog";
import { renderBrandedImage } from "@/lib/brands/renderBrandedImage";
import { readLimitedImage } from "@/lib/brands/readLimitedImage";

async function ownImage(path: string): Promise<Buffer> {
  const { url } = await runWithAmplifyServerContext({ nextServerContext: { cookies },
    operation: (context) => getUrl(context, { path, options: { expiresIn: 120 } }) });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("画像を取得できませんでした。");
  return readLimitedImage(response, 25_000_000);
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
    const source = await readLimitedImage(response, 2_000_000);
    logo = await sharp(source).resize({ width: 600, height: 300, fit: "inside" }).png().toBuffer();
    await saveImage(logoKey, logo, "image/png");
  }

  const result = await renderBrandedImage(photo, logo);
  const storageKey = `inventory/listing-branded/${randomUUID()}.jpg`;
  await saveImage(storageKey, result, "image/jpeg");
  return { storageKey };
}
