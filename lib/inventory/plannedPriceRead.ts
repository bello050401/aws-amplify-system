import 'server-only';
import {ScanCommand, type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {buildCountExpression} from './inventoryCountFast';
import {readCompactSearch} from './readCompactSearch';
import {readInventoryBatch} from './batchRead';
import {isPriceEntryTarget} from './plannedPrice';
import type {PriceEntryRecord} from './plannedPriceCore';

const FIELDS = ['id', 'sku', 'name', 'note', 'plannedSalePrice', 'updatedAt', 'listUpdatedAt',
  'categoryId', 'categoryIds', 'images', 'deletedAt', 'listingPartition'] as const;

/** Only IDs are read from the database-maintained index. Read their current
 * values consistently before displaying editable fields. No product cache.
 * Missing/unavailable index falls back to the complete original scan. */
export async function readPriceEntryRecords(db: Pick<DynamoDBDocumentClient, 'send'>, table: string, ids: readonly string[]) {
  if (!ids.length) return [];
  const filter = buildCountExpression({categoryIds: [...ids]});
  const base = {
    TableName: table,
    FilterExpression: filter.filterExpression + ' AND (attribute_not_exists(#price) OR #price = :emptyPrice OR #price = :nullPrice)',
    ExpressionAttributeNames: {...filter.names, '#price': 'plannedSalePrice'},
    ExpressionAttributeValues: {...filter.values, ':emptyPrice': '', ':nullPrice': null},
  };
  const indexed = await readCompactSearch(db, {...base, ProjectionExpression: 'id'},
    ['id', ...Object.values(base.ExpressionAttributeNames)]);
  let rows: PriceEntryRecord[];
  if (indexed !== null) {
    const current = await readInventoryBatch(db, table, indexed.map(row => String(row.id)), undefined, FIELDS);
    rows = [...current.values()] as PriceEntryRecord[];
  } else {
    const names = Object.fromEntries(FIELDS.map((name, i) => ['#v' + i, name]));
    const segments = await Promise.all(Array.from({length: 4}, async (_, segment) => {
      const resultRows: PriceEntryRecord[] = [];
      let cursor: Record<string, unknown> | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await db.send(new ScanCommand({...base, Segment: segment, TotalSegments: 4,
          ProjectionExpression: Object.keys(names).join(','),
          ExpressionAttributeNames: {...base.ExpressionAttributeNames, ...names}, ExclusiveStartKey: cursor}));
        resultRows.push(...(result.Items ?? []) as PriceEntryRecord[]);
        cursor = result.LastEvaluatedKey;
        if (!cursor) return resultRows;
      }
      throw Error('PRICE_ENTRY_READ_INCOMPLETE');
    }));
    rows = segments.flat();
  }
  return rows.filter(row => isPriceEntryTarget(row, ids)).sort((a,b) =>
    String(b.listUpdatedAt ?? b.updatedAt).localeCompare(String(a.listUpdatedAt ?? a.updatedAt)) || a.id.localeCompare(b.id));
}
