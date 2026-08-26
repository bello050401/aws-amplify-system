import { prisma } from "@/lib/prisma";
import { integrationLogger } from "@/lib/logger";
import { MercariApiError, MercariShopsClient } from "@/integrations/mercari-shops/MercariShopsClient";
import { getMercariEnvironment } from "@/integrations/mercari-shops/endpoints";
import { getMercariAccessToken } from "@/domain/services/MercariSettingsService";
import {
  CREATE_PRODUCT_MUTATION,
} from "@/integrations/mercari-shops/mutations/createProduct";
import type {
  CreateProductInput,
  CreateProductPayload,
} from "@/integrations/mercari-shops/types/CreateProductInput";
import { PRODUCT_QUERY, type ProductQueryResponse } from "@/integrations/mercari-shops/queries/product";
import { conditionToMercariValue } from "@/integrations/mercari-shops/mapper/condition";
import { shippingPayerToMercariValue } from "@/integrations/mercari-shops/mapper/shippingPayer";
import { shippingDurationToMercariValue } from "@/integrations/mercari-shops/mapper/shippingDuration";
import { internalStatusToMercariApiStatus } from "@/integrations/mercari-shops/mapper/productStatus";
import type {
  CreateListingResult,
  ExternalProduct,
  MarketplaceAdapter,
  UpdateListingResult,
} from "./MarketplaceAdapter";

/** [UNVERIFIED] 配送方法の暫定フォールバック値。docs/mercari-api.md 5節参照。 */
const FALLBACK_SHIPPING_METHOD = "MERCARI_SHIPPING"; // [UNVERIFIED]

export class MercariShopsAdapter implements MarketplaceAdapter {
  readonly channel = "MERCARI_SHOPS" as const;

  private client(): MercariShopsClient {
    const environment = getMercariEnvironment();
    return new MercariShopsClient({
      environment,
      getAccessToken: () => getMercariAccessToken(environment),
    });
  }

  async createProduct(productId: string): Promise<CreateListingResult> {
    const environment = getMercariEnvironment();
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: {
        images: { orderBy: { sortOrder: "asc" } },
        variants: true,
        categoryMapping: true,
        brandMapping: true,
        shippingTemplate: true,
      },
    });

    if (!product.categoryMapping) {
      throw new Error("カテゴリーが未設定です。末端カテゴリーを選択してください。");
    }
    if (product.images.length === 0) {
      throw new Error("画像が1枚も登録されていません。");
    }
    if (!product.shippingFromStateId) {
      throw new Error("配送元地域が未設定です。");
    }

    const input: CreateProductInput = {
      name: product.name,
      description: product.description,
      price: product.price,
      categoryId: product.categoryMapping.mercariCategoryId,
      brandId: product.brandMapping?.mercariBrandId ?? null,
      condition: conditionToMercariValue(product.condition),
      images: product.images.map((img, idx) => ({
        url: img.publicUrl,
        sortOrder: img.isPrimary ? 0 : idx + 1,
      })),
      shippingPayer: shippingPayerToMercariValue(product.shippingPayer),
      shippingMethod: FALLBACK_SHIPPING_METHOD,
      shippingDuration: product.shippingDurationCode
        ? shippingDurationToMercariValue(product.shippingDurationCode)
        : shippingDurationToMercariValue("FOUR_SEVEN_DAYS"),
      shippingFromStateId: product.shippingFromStateId,
      shippingConfigurationId: product.shippingTemplate?.mercariShippingConfigurationId ?? null,
      status: internalStatusToMercariApiStatus(product.internalStatus),
      variants:
        product.variants.length > 0
          ? product.variants.map((v) => ({
              skuCode: v.skuCode,
              stockQuantity: v.stockQuantity,
              janCode: product.janCode ?? null,
            }))
          : [{ skuCode: product.sku, stockQuantity: 1, janCode: product.janCode ?? null }],
      janCode: product.janCode ?? null,
      catalogId: product.catalogId ?? null,
    };

    await integrationLogger.info({
      productId,
      operation: "CREATE_PRODUCT",
      message: "createProduct送信",
    });

    try {
      const data = await this.client().request<CreateProductPayload>(
        CREATE_PRODUCT_MUTATION,
        { input },
        { disableRetry: true },
      );

      await prisma.mercariListing.upsert({
        where: { productId },
        create: {
          productId,
          mercariProductId: data.product.id,
          mercariStatus: data.product.status ?? null,
          environment,
          lastSyncedAt: new Date(),
          lastError: null,
        },
        update: {
          mercariProductId: data.product.id,
          mercariStatus: data.product.status ?? null,
          environment,
          lastSyncedAt: new Date(),
          lastError: null,
        },
      });

      await prisma.product.update({
        where: { id: productId },
        data: { internalStatus: "PUBLISHED" },
      });

      await integrationLogger.info({
        productId,
        operation: "CREATE_PRODUCT",
        message: `商品作成成功。Mercari Product ID保存: ${data.product.id}`,
      });

      return { externalProductId: data.product.id, externalStatus: data.product.status ?? null };
    } catch (err) {
      await this.recordFailure(productId, environment, "CREATE_PRODUCT", err);
      throw err;
    }
  }

  async updateProduct(productId: string): Promise<UpdateListingResult> {
    // Phase 2 (指示書41項) で実装する。Phase 1では未対応。
    throw new Error(
      `updateProduct(${productId}) is a Phase 2 feature and is not implemented yet. See docs/implementation-plan.md.`,
    );
  }

  async getProduct(externalId: string): Promise<ExternalProduct> {
    const data = await this.client().request<ProductQueryResponse>(PRODUCT_QUERY, {
      id: externalId,
    });
    if (!data.product) {
      throw new Error(`Mercari product not found: ${externalId}`);
    }
    return {
      externalProductId: data.product.id,
      status: data.product.status,
      raw: data.product,
    };
  }

  private async recordFailure(
    productId: string,
    environment: string,
    operation: string,
    err: unknown,
  ) {
    const isApiError = err instanceof MercariApiError;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = isApiError ? err.errors[0]?.extensions?.code ?? null : null;
    const requestId = isApiError ? err.requestId ?? null : null;

    await prisma.mercariListing.upsert({
      where: { productId },
      create: {
        productId,
        environment,
        lastSyncedAt: new Date(),
        lastError: errorMessage,
      },
      update: {
        lastError: errorMessage,
        lastSyncedAt: new Date(),
      },
    });

    await prisma.product.update({
      where: { id: productId },
      data: { internalStatus: "ERROR" },
    });

    await integrationLogger.error({
      productId,
      operation,
      message: "APIエラー",
      errorCode: errorCode ? String(errorCode) : null,
      errorMessage,
      requestId,
    });
  }
}
