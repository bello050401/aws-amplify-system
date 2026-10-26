import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { uploadData, getUrl } from "@/lib/security/serverStorage";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { resolveListingImageDownloadUrl } from "./mercari/csv/buildExportRows";
import type { ListingImageRef } from "./types";

/** Only saved BELLO image references reach here, never a client-supplied URL. */
export async function ecImageJpeg(ref: ListingImageRef): Promise<Uint8Array> {
  const url = await resolveListingImageDownloadUrl(ref);
  if (!url) throw Error("画像の保存先を確認できません。");
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw Error("画像を読み込めません。");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 20 * 1024 * 1024) {
        await reader.cancel();
        throw Error("画像が大きすぎます。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = await sharp(Buffer.concat(chunks), {
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "white" })
    .jpeg({ quality: 85 })
    .toBuffer();
  if (bytes.length > 4 * 1024 * 1024)
    throw Error("画像を送信用サイズに変換できません。");
  return new Uint8Array(bytes);
}
export async function baseImageUrl(ref: ListingImageRef) {
  const bytes = await ecImageJpeg(ref),
    digest = createHash("sha256").update(bytes).digest("hex");
  const path = `inventory/ec-export/${digest}.jpg`;
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async (context) => {
      await uploadData(context, {
        path,
        data: bytes,
        options: { contentType: "image/jpeg" },
      }).result;
      return (
        await getUrl(context, { path, options: { expiresIn: 900 } })
      ).url.toString();
    },
  });
}
