/** A database-maintained projection, not a second source of inventory truth.
 * Every Inventory has id, so imports/deletions/new writers need no dual write.
 * No images, provider payloads, notes, customer details or custom fields.
 */
export const COMPACT_SEARCH_INDEX = 'inventorySearchCompactV1';
export const COMPACT_SEARCH_FIELDS = [
  'id', 'listingPartition', 'updatedAt', 'listUpdatedAt', 'createdAt', 'deletedAt',
  'sku', 'name', 'sourceSystem', 'sourceInventoryId', 'quantity', 'unit',
  'categoryId', 'categoryIds', 'locationId', 'statusId', 'barcode',
  'plannedSalePrice', 'salePrice', 'purchasePrice',
] as const;

const attributes = new Set<string>(COMPACT_SEARCH_FIELDS);
export function supportsCompactSearch(fields: readonly string[]): boolean {
  return fields.every(field => attributes.has(field));
}
