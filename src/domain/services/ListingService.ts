import { prisma } from "@/lib/prisma";
import { integrationLogger } from "@/lib/logger";
import { MercariShopsAdapter } from "@/domain/adapters/MercariShopsAdapter";
import type { CreateListingResult } from "@/domain/adapters/MarketplaceAdapter";

export class ListingValidationError extends Error {}

/**
 * 「メルカリShopsへ出品」操作のオーケストレーション（指示書35項の1〜11の流れ）。
 * 事前検証はここで行い、実際のAPI呼び出し・DB保存はAdapterに委譲する。
 */
export async function createMercariListing(productId: string): Promise<CreateListingResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { images: true, categoryMapping: true, variants: true },
  });
  if (!product) {
    throw new ListingValidationError("商品が見つかりません。");
  }

  await integrationLogger.info({ productId, operation: "LISTING_START", message: "出品開始" });

  // 1. 入力値検証
  if (!product.name || !product.description || !product.price) {
    throw new ListingValidationError("商品名・説明・価格は必須です。");
  }

  // 2. SKU重複確認（DBのユニーク制約により基本的に重複しないが、明示的に確認しログする）
  await integrationLogger.info({ productId, operation: "LISTING_SKU_CHECK", message: "SKU確認" });
  const skuOwners = await prisma.product.count({ where: { sku: product.sku } });
  if (skuOwners !== 1) {
    throw new ListingValidationError(`SKU "${product.sku}" の状態が不正です。`);
  }

  // 3. 画像URL確認
  await integrationLogger.info({ productId, operation: "LISTING_IMAGE_CHECK", message: "画像確認" });
  if (product.images.length === 0) {
    throw new ListingValidationError("画像が1枚も登録されていません。");
  }
  for (const img of product.images) {
    if (!/^https?:\/\//.test(img.publicUrl)) {
      throw new ListingValidationError(
        `画像URLが外部公開されていません: ${img.publicUrl}（ローカル開発時はPUBLIC_UPLOAD_BASE_URLを確認してください）`,
      );
    }
  }

  // 4. カテゴリー確認（末端カテゴリーのみ）
  await integrationLogger.info({
    productId,
    operation: "LISTING_CATEGORY_CHECK",
    message: "カテゴリー確認",
  });
  if (!product.categoryMapping) {
    throw new ListingValidationError("カテゴリーが未設定です。");
  }
  if (!product.categoryMapping.isLeaf) {
    throw new ListingValidationError("末端カテゴリー（子カテゴリーが無いもの）を選択してください。");
  }

  // 5. 配送設定確認
  await integrationLogger.info({
    productId,
    operation: "LISTING_SHIPPING_CHECK",
    message: "配送設定確認",
  });
  if (!product.shippingFromStateId) {
    throw new ListingValidationError("配送元地域が未設定です。");
  }

  // 6〜10. Payload生成〜Mercari Product ID保存 は Adapter 内で実行
  const adapter = new MercariShopsAdapter();
  const result = await adapter.createProduct(productId);

  // 11. 成功表示（呼び出し元 = Route Handler が画面へ返す）
  return result;
}
