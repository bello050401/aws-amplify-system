/** BASE detail response must identify the exact item and a known display flag. */
export function parseBaseItemVisibility(payload: unknown, itemId: string): boolean {
  if (!/^[1-9][0-9]*$/.test(itemId) || !payload || typeof payload !== "object") throw new Error("BASE商品の公開状態を確認できませんでした。");
  const item = (payload as { item?: unknown }).item;
  if (!item || typeof item !== "object") throw new Error("BASE商品の公開状態を確認できませんでした。");
  const row = item as Record<string, unknown>;
  if (String(row.item_id) !== itemId || ![0, 1, "0", "1"].includes(row.visible as string | number))
    throw new Error("BASE商品の公開状態を確認できませんでした。");
  return String(row.visible) === "1";
}
