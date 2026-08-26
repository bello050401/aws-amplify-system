import { prisma } from "@/lib/prisma";
import type { ShippingTemplateType } from "@prisma/client";

/**
 * 配送テンプレート管理（指示書27〜30項）。商品登録画面ではテンプレートを選ぶだけで
 * 配送関連フィールドが自動反映される。Mercari側のShippingConfiguration IDとの
 * 紐付けは `mercariShippingConfigurationId` に保持する（createProductShippingConfiguration
 * の実行はPhase 2で本格対応、Phase 1では手動設定した値をそのまま保存できる構造のみ用意）。
 */

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

export async function getDefaultShippingTemplate() {
  return prisma.shippingTemplate.findFirst({ where: { isDefault: true } });
}
