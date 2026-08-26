import { prisma } from "@/lib/prisma";
import type { ProductConditionCode } from "@prisma/client";

/**
 * トークン以外の一般設定（デフォルト商品状態、デフォルト配送元都道府県等）。
 * 平文でよい値のみここで扱う。機密値は MercariSettingsService を使うこと。
 */

const DEFAULT_CONDITION_KEY = "defaults.productCondition";
const DEFAULT_SHIPPING_FROM_STATE_KEY = "defaults.shippingFromStateId";

export async function getDefaultCondition(): Promise<ProductConditionCode> {
  const row = await prisma.appSetting.findUnique({ where: { key: DEFAULT_CONDITION_KEY } });
  return (row?.value as ProductConditionCode) ?? "SLIGHT_DAMAGE"; // 指示書14項の例
}

export async function setDefaultCondition(code: ProductConditionCode) {
  await prisma.appSetting.upsert({
    where: { key: DEFAULT_CONDITION_KEY },
    create: { key: DEFAULT_CONDITION_KEY, value: code },
    update: { value: code },
  });
}

export async function getDefaultShippingFromStateId(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: DEFAULT_SHIPPING_FROM_STATE_KEY },
  });
  return row?.value ?? null;
}

export async function setDefaultShippingFromStateId(stateId: string) {
  await prisma.appSetting.upsert({
    where: { key: DEFAULT_SHIPPING_FROM_STATE_KEY },
    create: { key: DEFAULT_SHIPPING_FROM_STATE_KEY, value: stateId },
    update: { value: stateId },
  });
}
