import 'server-only';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {buildCountExpression} from './inventoryCountFast';
import {readCompactSearch} from './readCompactSearch';
import {readInventoryBatch} from './batchRead';
import {inventoryCategoryIds} from './categories';

/** Authenticated caller only. The index discovers IDs; strongly consistent
 * source reads recheck deletion/category changes before returning any stock.
 * null means the caller must use its existing authenticated scan, not []. */
export async function readEcEligibleRecords(db: Pick<DynamoDBDocumentClient,'send'>, table: string, categoryIds: string[]) {
  if (!categoryIds.length) return [];
  const filter = buildCountExpression({categoryIds});
  const indexed = await readCompactSearch(db, {
    TableName: table, ProjectionExpression: 'id', FilterExpression: filter.filterExpression,
    ExpressionAttributeNames: filter.names, ExpressionAttributeValues: filter.values,
  }, ['id', 'deletedAt', 'listingPartition', 'categoryId', 'categoryIds']);
  if (indexed === null) return null;
  // Preserve the existing toListRow contract, including image precedence and
  // historical fields. These records stay on the server; the overview emits
  // its existing limited fields. No cross-request product cache is introduced.
  const current = await readInventoryBatch(db, table, indexed.map(row => String(row.id)));
  const eligible = new Set(categoryIds);
  return [...current.values()].filter(row => !row.deletedAt && row.listingPartition !== 'MERGED'
    && inventoryCategoryIds(row).some(id => eligible.has(id)));
}
