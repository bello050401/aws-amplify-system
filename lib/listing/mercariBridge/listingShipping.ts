/** Values observed in the shop's product editor (2026-10-17). */
export const SHOPS_DELIVERY_METHODS = [
  "METHOD_TYPE_UNDECIDED",
  "METHOD_MERCARI_SHIPPING_YAMATO",
] as const;
export type ShopsDeliveryMethod = (typeof SHOPS_DELIVERY_METHODS)[number];
export function isShopsDeliveryMethod(
  value: unknown,
): value is ShopsDeliveryMethod {
  return (
    typeof value === "string" &&
    SHOPS_DELIVERY_METHODS.includes(value as ShopsDeliveryMethod)
  );
}
export function shopsDeliveryLabel(value: ShopsDeliveryMethod) {
  return value === "METHOD_MERCARI_SHIPPING_YAMATO"
    ? "らくらくメルカリ便（匿名配送）"
    : "未定（出品者が手配）";
}
