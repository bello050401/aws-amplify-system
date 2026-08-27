import { randomUUID } from "crypto";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

export class InvalidImageError extends Error {}

/**
 * 画像アップロードの検証・保存・DB登録を行う（指示書11, 12, 56項）。
 * 1商品に複数画像を登録でき、並び順・メイン画像フラグを管理する。
 */
export async function addProductImage(params: {
  productId: string;
  file: File;
}): Promise<void> {
  const { productId, file } = params;

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new InvalidImageError(`許可されていないファイル形式です: ${file.type || "unknown"}`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new InvalidImageError("ファイルサイズが上限(15MB)を超えています。");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = extensionFromMime(file.type);
  const key = `products/${productId}/${randomUUID()}${ext}`;

  const stored = await getStorageProvider().put({
    key,
    data: buffer,
    contentType: file.type,
  });

  const existingCount = await prisma.productImage.count({ where: { productId } });

  await prisma.productImage.create({
    data: {
      productId,
      storageKey: stored.storageKey,
      publicUrl: stored.publicUrl,
      sortOrder: existingCount,
      isPrimary: existingCount === 0,
    },
  });
}

export async function reorderProductImages(productId: string, orderedImageIds: string[]) {
  await prisma.$transaction(
    orderedImageIds.map((imageId, index) =>
      prisma.productImage.update({
        where: { id: imageId },
        data: { sortOrder: index, isPrimary: index === 0 },
      }),
    ),
  );
  // 念のため対象productId以外が混入していないことを確認
  const count = await prisma.productImage.count({
    where: { productId, id: { in: orderedImageIds } },
  });
  if (count !== orderedImageIds.length) {
    throw new Error("並び替え対象の画像が商品と一致しません。");
  }
}

export async function deleteProductImage(imageId: string) {
  const image = await prisma.productImage.findUniqueOrThrow({ where: { id: imageId } });
  await getStorageProvider().remove(image.storageKey);
  await prisma.productImage.delete({ where: { id: imageId } });

  // メイン画像を削除した場合、残りの先頭を新しいメイン画像にする
  const remaining = await prisma.productImage.findMany({
    where: { productId: image.productId },
    orderBy: { sortOrder: "asc" },
  });
  if (remaining.length > 0 && !remaining.some((i) => i.isPrimary)) {
    await prisma.productImage.update({
      where: { id: remaining[0].id },
      data: { isPrimary: true },
    });
  }
}

function extensionFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return path.extname(mime) || "";
  }
}
