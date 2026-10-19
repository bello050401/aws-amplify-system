/** Inventory quantity is stored as an AppSync Int and shared with the PWA. */
export function inventoryQuantityError(value: number | null | undefined): string | null {
  const quantity = value ?? 0;
  if (!Number.isInteger(quantity) || quantity < 0) return "数量は0以上の整数で入力してください。";
  if (quantity > 2_147_483_647) return "数量は2,147,483,647以下で入力してください。";
  return null;
}
