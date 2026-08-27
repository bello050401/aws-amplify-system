import { prisma } from "@/lib/prisma";
import type { ProductConditionCode, ShippingPayerCode } from "@prisma/client";
import { generateNextSku, isSkuTaken } from "./SkuGenerator";
import type { ProductFormValues } from "@/domain/validation/productSchema";

export class SkuConflictError extends Error {
  constructor(sku: string) {
    super(`SKU "${sku}" は既に使用されています。`);
    this.name = "SkuConflictError";
  }
}

const productListInclude = {
  images: { orderBy: { sortOrder: "asc" as const }, take: 1, where: { isPrimary: true } },
  mercariListing: true,
  categoryMapping: true,
  brandMapping: true,
} as const;

export async function listProducts() {
  return prisma.product.findMany({
    include: productListInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getProductDetail(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: true,
      categoryMapping: true,
      brandMapping: true,
      shippingTemplate: true,
      mercariListing: true,
      integrationLogs: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
}

export async function suggestNextSku() {
  return generateNextSku();
}

export async function createProduct(input: ProductFormValues) {
  if (await isSkuTaken(input.sku)) {
    throw new SkuConflictError(input.sku);
  }
  return prisma.product.create({
    data: {
      sku: input.sku,
      name: input.name,
      description: input.description,
      price: input.price,
      condition: input.condition as ProductConditionCode,
      janCode: input.janCode || null,
      catalogId: input.catalogId || null,
      categoryMappingId: input.categoryMappingId || null,
      brandMappingId: input.brandMappingId || null,
      shippingPayer: input.shippingPayer as ShippingPayerCode,
      shippingFromStateId: input.shippingFromStateId || null,
      shippingDurationCode: input.shippingDurationCode || null,
      shippingMethodCode: input.shippingMethodCode || null,
      shippingTemplateId: input.shippingTemplateId || null,
      variants: {
        create: {
          skuCode: input.sku,
          stockQuantity: input.stockQuantity ?? 1,
        },
      },
    },
  });
}

export async function updateProduct(id: string, input: ProductFormValues) {
  if (await isSkuTaken(input.sku, id)) {
    throw new SkuConflictError(input.sku);
  }
  return prisma.product.update({
    where: { id },
    data: {
      sku: input.sku,
      name: input.name,
      description: input.description,
      price: input.price,
      condition: input.condition as ProductConditionCode,
      janCode: input.janCode || null,
      catalogId: input.catalogId || null,
      categoryMappingId: input.categoryMappingId || null,
      brandMappingId: input.brandMappingId || null,
      shippingPayer: input.shippingPayer as ShippingPayerCode,
      shippingFromStateId: input.shippingFromStateId || null,
      shippingDurationCode: input.shippingDurationCode || null,
      shippingMethodCode: input.shippingMethodCode || null,
      shippingTemplateId: input.shippingTemplateId || null,
    },
  });
}

export async function deleteProduct(id: string) {
  await prisma.product.delete({ where: { id } });
}

export async function setProductHidden(id: string, hidden: boolean) {
  await prisma.product.update({
    where: { id },
    data: { internalStatus: hidden ? "HIDDEN" : "READY" },
  });
}

/**
 * 商品複製（指示書44項）。商品名・説明・カテゴリー・ブランド・状態・配送設定・価格を複製し、
 * SKUは新規採番。画像は `copyImages` が true の場合のみ複製する（同一storageKey/URLを
 * 参照する新しいProductImageレコードを作成。物理ファイル自体は複製しない簡易実装）。
 * Mercari Product ID (MercariListing) は絶対に複製しない。
 */
export async function duplicateProduct(id: string, options: { copyImages: boolean }) {
  const source = await prisma.product.findUniqueOrThrow({
    where: { id },
    include: { images: { orderBy: { sortOrder: "asc" } } },
  });

  const newSku = await generateNextSku();

  return prisma.product.create({
    data: {
      sku: newSku,
      name: source.name,
      description: source.description,
      price: source.price,
      condition: source.condition,
      internalStatus: "DRAFT",
      janCode: null, // 家具は個体差があるため複製しない
      catalogId: source.catalogId,
      categoryMappingId: source.categoryMappingId,
      brandMappingId: source.brandMappingId,
      shippingPayer: source.shippingPayer,
      shippingFromStateId: source.shippingFromStateId,
      shippingDurationCode: source.shippingDurationCode,
      shippingMethodCode: source.shippingMethodCode,
      shippingTemplateId: source.shippingTemplateId,
      variants: { create: { skuCode: newSku, stockQuantity: 1 } },
      images: options.copyImages
        ? {
            create: source.images.map((img) => ({
              storageKey: img.storageKey,
              publicUrl: img.publicUrl,
              sortOrder: img.sortOrder,
              isPrimary: img.isPrimary,
            })),
          }
        : undefined,
      // mercariListing は意図的に作成しない
    },
  });
}
