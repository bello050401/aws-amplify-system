/** DynamoDB maintains this small projection for every inventory id. */
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
