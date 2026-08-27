import { prisma } from "@/lib/prisma";
import type { ShippingTemplateType } from "@prisma/client";
import { MercariShopsClient } from "@/integrations/mercari-shops/MercariShopsClient";
import { getMercariAccessToken } from "./MercariSettingsService";
import {
  SHIPPING_METHODS_QUERY,
  type ShippingMethodsResponse,
} from "@/integrations/mercari-shops/queries/shippingOptions";
import {
  CREATE_PRODUCT_SHIPPING_CONFIGURATION_MUTATION,
  type CreateProductShippingConfigurationPayload,
} from "@/integrations/mercari-shops/mutations/createProductShippingConfiguration";
import { integrationLogger } from "@/lib/logger";

/**
 * 配送テンプレート管理（指示書27〜30項）。商品登録画面ではテンプレートを選ぶだけで
 * 配送関連フィールドが自動反映される。Mercari側のShippingConfiguration IDとの
 * 紐付けは `mercariShippingConfigurationId` に保持し、`createShippingConfigurationForTemplate`
 * から実際に `createProductShippingConfiguration` を呼び出して自動取得できる
 * （手動でIDを入力することも引き続き可能）。
 */

/**
 * [UNVERIFIED] `ShippingMethod` のオフライン時フォールバック候補。
 * 指示書26項に基づき、通常はAPIからの動的取得を優先し、これは接続不可時のみ使用する
 * （docs/mercari-api.md 5節参照）。
 */
const FALLBACK_SHIPPING_METHODS: { code: string; label: string }[] = [
  { code: "MERCARI_SHIPPING", label: "らくらくメルカリ便（想定） [UNVERIFIED]" },
  { code: "OTHER", label: "その他の配送方法 [UNVERIFIED]" },
];

/**
 * 配送方法の選択肢を取得する。まずMercari Shops APIのSchemaから動的取得を試み、
 * トークン未設定・接続失敗時のみ最小限のフォールバックを返す（画面を壊さないため）。
 */
export async function getShippingMethods(): Promise<{ code: string; label: string }[]> {
  try {
    const client = new MercariShopsClient({ getAccessToken: getMercariAccessToken });
    const data = await client.request<ShippingMethodsResponse>(SHIPPING_METHODS_QUERY, {});
    const values = data.__type?.enumValues ?? [];
    if (values.length === 0) {
      return FALLBACK_SHIPPING_METHODS;
    }
    await integrationLogger.info({
      operation: "SYNC_SHIPPING_METHODS",
      message: `配送方法を取得 (${values.length}件)`,
    });
    return values.map((v) => ({ code: v.name, label: v.description ?? v.name }));
  } catch (err) {
    console.error("[ShippingService] falling back to offline shipping methods", err);
    return FALLBACK_SHIPPING_METHODS;
  }
}

export async function listShippingTemplates() {
  return prisma.shippingTemplate.findMany({
    include: { rates: true },
    orderBy: { name: "asc" },
  });
}

export async function createShippingTemplate(input: {
  name: string;
  type: ShippingTemplateType;
  mercariShippingConfigurationId?: string | null;
  isDefault?: boolean;
  rates?: { destination: string; fee: number }[];
}) {
  if (input.isDefault) {
    await prisma.shippingTemplate.updateMany({ data: { isDefault: false }, where: {} });
  }
  return prisma.shippingTemplate.create({
    data: {
      name: input.name,
      type: input.type,
      mercariShippingConfigurationId: input.mercariShippingConfigurationId ?? null,
      isDefault: input.isDefault ?? false,
      rates: input.rates ? { create: input.rates } : undefined,
    },
  });
}

export async function deleteShippingTemplate(id: string) {
  await prisma.shippingTemplate.delete({ where: { id } });
}

/**
 * 配送テンプレートに登録済みの都道府県別送料から、Mercari Shops側の
 * `createProductShippingConfiguration` を実行し、返却された
 * ShippingConfiguration IDを自社テンプレートへ保存する（指示書27, 29項）。
 * Sandboxトークン未設定・API未接続の場合はエラーを握り潰さずそのまま投げる。
 */
export async function createShippingConfigurationForTemplate(templateId: string) {
  const template = await prisma.shippingTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { rates: true },
  });

  if (template.rates.length === 0) {
    throw new Error(
      "都道府県別送料が1件も登録されていません。先にShippingTemplateRateを追加してください。",
    );
  }

  const client = new MercariShopsClient({ getAccessToken: getMercariAccessToken });

  try {
    const data = await client.request<CreateProductShippingConfigurationPayload>(
      CREATE_PRODUCT_SHIPPING_CONFIGURATION_MUTATION,
      {
        input: {
          name: template.name,
          rates: template.rates.map((r) => ({ destination: r.destination, fee: r.fee })),
        },
      },
      { disableRetry: true },
    );

    const configurationId = data.createProductShippingConfiguration.shippingConfiguration.id;

    await prisma.shippingTemplate.update({
      where: { id: templateId },
      data: { mercariShippingConfigurationId: configurationId },
    });

    await integrationLogger.info({
      operation: "CREATE_SHIPPING_CONFIGURATION",
      message: `配送設定作成成功: ${template.name} → ${configurationId}`,
    });

    return configurationId;
  } catch (err) {
    await integrationLogger.error({
      operation: "CREATE_SHIPPING_CONFIGURATION",
      message: "配送設定の作成に失敗しました",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function getDefaultShippingTemplate() {
  return prisma.shippingTemplate.findFirst({ where: { isDefault: true } });
}
