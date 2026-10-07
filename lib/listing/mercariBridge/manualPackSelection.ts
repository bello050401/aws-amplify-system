export type ManualPackSelection = {
  price: string;
  quantity: string;
  categoryId: string | null;
  brandId: string | null;
};

/** A delayed server response is usable only for the exact fields submitted. */
export function sameManualPackSelection(
  requested: ManualPackSelection, current: ManualPackSelection,
): boolean {
  return requested.price === current.price &&
    requested.quantity === current.quantity &&
    requested.categoryId === current.categoryId &&
    requested.brandId === current.brandId;
}
