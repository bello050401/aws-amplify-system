/** The shared quantity is a listing choice, never an Inventory stock mutation. */
export function listingQuantity(draft: {quantity?: number|null}|null, available: number): number {
  return draft?.quantity ?? available;
}
