import type { ShippingPayerCode } from "@prisma/client";

/**
 * [UNVERIFIED] `mercariValue` はメルカリShops API `ShippingPayer` enumの暫定値
 * (docs/mercari-api.md 5節)。Sandbox接続確立後に実際の値へ更新すること。
 */
export const SHIPPING_PAYERS: { code: ShippingPayerCode; label: string; mercariValue: string }[] = [
  { code: "SELLER", label: "送料込み（出品者負担）", mercariValue: "SELLER" },
  { code: "BUYER", label: "着払い（購入者負担）", mercariValue: "BUYER" },
];

export function shippingPayerLabel(code: ShippingPayerCode): string {
  return SHIPPING_PAYERS.find((p) => p.code === code)?.label ?? code;
}

export function shippingPayerToMercariValue(code: ShippingPayerCode): string {
  const found = SHIPPING_PAYERS.find((p) => p.code === code);
  if (!found) throw new Error(`Unknown ShippingPayerCode: ${code}`);
  return found.mercariValue;
}
