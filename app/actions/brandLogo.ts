"use server";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cookies } from "next/headers";
import sharp from "sharp";
import { getUrl, uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { findBrandByName } from "@/lib/brands/catalog";
import { renderBrandedImage } from "@/lib/brands/renderBrandedImage";
import { readLimitedImage } from "@/lib/brands/readLimitedImage";
import { listInventoryPhotoAssetsAction } from "@/app/actions/photoRegistration";
import { refreshGallerySelection } from "@/lib/photoRegistration/gallerySelection";

class MissingStoredImage extends Error {}

async function ownImage(path: string): Promise<Buffer> {
  const { url } = await runWithAmplifyServerContext({ nextServerContext: { cookies },
    operation: (context) => getUrl(context, { path, options: { expiresIn: 120 } }) });
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (response.status === 404) throw new MissingStoredImage("登録済み画像がありません。");
  if (!response.ok) throw new Error("画像を取得できませんでした。");
  return readLimitedImage(response, 25_000_000);
}

async function saveImage(path: string, bytes: Buffer, contentType: string, replaceable = false): Promise<void> {
  await runWithAmplifyServerContext({ nextServerContext: { cookies },
    operation: (context) => uploadData(context, { path, data: bytes,
      options: { contentType, cacheControl: replaceable ? "private, no-cache" : "private, max-age=31536000, immutable" } }).result });
}

/** Called only by an explicit opt-in on the EC listing screen. The original photo stays intact. */
async function createBrandedImage(inventoryId: string): Promise<{ storageKey: string }> {
  if (!canEditInventory(await getInventoryRole())) throw new Error("画像を編集する権限がありません。");
  const item = await getInventoryDetail(inventoryId);
  if (!item) throw new Error("商品が見つかりません。");
  const selectedName = typeof item.customFields?.belloBrand === "string" ? item.customFields.belloBrand : "";
  const brand = findBrandByName(selectedName);

  const photos = await listInventoryPhotoAssetsAction(inventoryId);
  if (!photos.ok) throw new Error("撮影画像を確認できませんでした。再試行してください。");
  if (photos.value.truncated) throw new Error("撮影画像の取得が途中のため、トップ画像を確認できませんでした。");
  const shootingTop = refreshGallerySelection(photos.value.assets, false, "").assets[0];
  let photo: Buffer;
  if (shootingTop) {
    if (!shootingTop.processedUrl) throw new Error("撮影トップ画像を取得できませんでした。");
    const response = await fetch(shootingTop.processedUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("撮影トップ画像を取得できませんでした。");
    photo = await readLimitedImage(response, 25_000_000);
  } else {
    const top = item.images.find((image) => image.type === "NORMAL" && image.isPrimary)
      ?? item.images.find((image) => image.type === "NORMAL");
    if (!top) throw new Error("トップ画像がありません。");
    photo = await ownImage(top.storageKey);
  }
  let productBrandLogo: Buffer | null = null;
  if (selectedName.trim()) {
    try { productBrandLogo = await ownImage(customLogoKey(selectedName)); }
    catch (error) {
      if (!(error instanceof MissingStoredImage)) throw new Error("保存済みロゴの確認に失敗しました。接続を確認して再試行してください。");
      if (brand?.logoUrl) {
        const logoUrl = new URL(brand.logoUrl);
        if (logoUrl.protocol !== "https:" || !["img.tabroom.jp", "dopa.co.jp", "www.dopa.co.jp"].includes(logoUrl.hostname))
          throw new Error("このロゴURLは利用できません。ロゴ画像をアップロードしてください。");
        const logoKey = `inventory/brand-logos/${brand.id}.png`;
        try { productBrandLogo = await ownImage(logoKey); }
        catch (error) {
          if (!(error instanceof MissingStoredImage)) throw new Error("保存済みロゴを取得できませんでした。再試行してください。");
          const response = await fetch(logoUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
          const mime = (response.headers.get("content-type") ?? "").split(";")[0];
          if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("ブランドロゴを取得できませんでした。ロゴ画像をアップロードしてください。");
          const source = await readLimitedImage(response, 2_000_000);
          productBrandLogo = await sharp(source).resize({ width: 600, height: 300, fit: "inside" }).png().toBuffer();
          await saveImage(logoKey, productBrandLogo, "image/png");
        }
      }
    }
  }

  // The supplied BELLO INTERIOR listing mark is independent of the item's product brand.
  const belloLogo = await readFile(join(process.cwd(), "public", "bello-interior-listing-logo.png"));
  const result = await renderBrandedImage(photo, { bello: belloLogo, productBrand: productBrandLogo });
  const storageKey = `inventory/listing-branded/${randomUUID()}.jpg`;
  await saveImage(storageKey, result, "image/jpeg");
  return { storageKey };
}

function customLogoKey(name: string): string {
  const normalized = findBrandByName(name)?.name ?? name;
  const id = createHash("sha256").update(normalized.normalize("NFKC").trim().toLocaleLowerCase()).digest("hex");
  return `inventory/brand-logos/custom/${id}.png`;
}

type LogoResult = { ok: true; storageKey: string } | { ok: false; message: string };
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && /[ぁ-んァ-ン一-龯]/.test(error.message) ? error.message : fallback;
}

export async function createBrandedListingImageAction(inventoryId: string): Promise<LogoResult> {
  try { return { ok: true, ...await createBrandedImage(inventoryId) }; }
  catch (error) { return { ok: false, message: errorMessage(error, "ロゴ画像を作成できませんでした。画像と接続を確認して再試行してください。") }; }
}

export async function uploadBrandLogoAction(inventoryId: string, form: FormData): Promise<LogoResult> {
  try {
    if (!canEditInventory(await getInventoryRole())) throw new Error("ロゴを登録する権限がありません。");
    const item = await getInventoryDetail(inventoryId);
    const name = typeof item?.customFields?.belloBrand === "string" ? item.customFields.belloBrand.trim() : "";
    if (!name) throw new Error("商品編集画面でブランド名を選び、保存してからロゴを登録してください。");
    const file = form.get("logo");
    if (!(file instanceof File) || !file.size || file.size > 750_000) throw new Error("750KB以下のロゴ画像を選んでください。");
    const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 16_000_000 });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1)
      throw new Error("PNG・JPEG・WebPの静止画像を選んでください。");
    const logo = await image.rotate().resize({ width: 600, height: 300, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const storageKey = customLogoKey(name);
    await saveImage(storageKey, logo, "image/png", true);
    return { ok: true, storageKey };
  } catch (error) { return { ok: false, message: errorMessage(error, "ロゴの保存に失敗しました。画像形式や接続を確認して再試行してください。") }; }
}
