/**
 * BELLO統合改修 master指示書 Phase D — origin/claude/
 * mercari-shops-auto-listing-ag0w6m branchのintegrations/mercari-shops/
 * mapper/shippingPayer.tsから移植。
 *
 * BELLOにはZAICO由来のshippingCost(送料)概念こそあるが、それを
 * 「誰が負担するか」を表す既存フィールドは無いため、この列挙型は
 * Phase Dで新設したlib/listing/types.tsのShippingPayerCodeを使う
 * (元ブランチの`@prisma/client`由来のShippingPayerCode型を、この
 * アプリの型へ差し替えただけでロジックは無変更)。
 *
 * [UNVERIFIED] `mercariValue`はメルカリShops API `ShippingPayer` enumの
 * 暫定値。Sandbox接続確立後に実際の値へ更新すること。
 */
import type { ShippingPayerCode } from "../../types";

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
