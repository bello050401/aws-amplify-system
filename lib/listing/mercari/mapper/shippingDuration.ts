/**
 * [UNVERIFIED] メルカリShops API `ShippingDuration` enumの暫定値
 * (BELLO統合改修 master指示書 Phase D — origin/claude/
 * mercari-shops-auto-listing-ag0w6m branchのintegrations/mercari-shops/
 * mapper/shippingDuration.tsから移植、ロジック無変更)。Sandbox接続
 * 確立後に実際の選択肢へ更新すること。
 */
export const SHIPPING_DURATIONS: { code: string; label: string; mercariValue: string }[] = [
  { code: "ONE_TWO_DAYS", label: "1〜2日", mercariValue: "ONE_TWO_DAYS" },
  { code: "TWO_THREE_DAYS", label: "2〜3日", mercariValue: "TWO_THREE_DAYS" },
  { code: "FOUR_SEVEN_DAYS", label: "4〜7日", mercariValue: "FOUR_SEVEN_DAYS" },
  { code: "EIGHT_OR_MORE_DAYS", label: "8日以上", mercariValue: "EIGHT_OR_MORE_DAYS" },
];

export function shippingDurationLabel(code: string): string {
  return SHIPPING_DURATIONS.find((d) => d.code === code)?.label ?? code;
}

export function shippingDurationToMercariValue(code: string): string {
  const found = SHIPPING_DURATIONS.find((d) => d.code === code);
  if (!found) throw new Error(`Unknown shipping duration code: ${code}`);
  return found.mercariValue;
}
