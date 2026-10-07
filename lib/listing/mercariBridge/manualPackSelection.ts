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

/** B005396 can be reviewed only with an explicit category and in-stock quantity. */
export function b005396ReviewSelectionReady(
  selection: ManualPackSelection, availableQuantity: number,
): boolean {
  if (selection.price !== "99999" || !selection.categoryId ||
      !Number.isSafeInteger(availableQuantity) || availableQuantity < 1 ||
      !/^[1-9][0-9]*$/.test(selection.quantity)) return false;
  const quantity = Number(selection.quantity);
  return Number.isSafeInteger(quantity) && quantity <= availableQuantity;
}
