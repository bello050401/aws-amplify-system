import 'server-only';
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readInventoryBatch } from '../batchRead';
import { catalogCategories, type CatalogCategories, type Row } from './policy';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
/** Projection is an explicit data boundary: costs, people, notes and custom fields never leave DynamoDB. */
export const CATALOG_ATTRIBUTES = ['id', 'sku', 'name', 'quantity', 'width', 'depth', 'height', 'images',
  'categoryId', 'categoryIds', 'deletedAt', 'isDeleted', 'listingPartition', 'mergedIntoId', 'mergedIntoInventoryId',
  'saleEndDate', 'soldAt', 'outboundBatchId', 'outboundArrivalBatchId', 'updatedAt', 'listUpdatedAt'] as const;
function projection(attributes: readonly string[]) {
  return { ProjectionExpression: attributes.map((_, index) => '#p' + index).join(','),
    ExpressionAttributeNames: Object.fromEntries(attributes.map((field, index) => ['#p' + index, field])) };
}

/** The only cross-request cache contains candidate IDs for at most 15 seconds.
 * Every response rereads current rows and masters consistently; removed/sold stock never survives in this cache. */
export function createCatalogReader(db: Db, table: (model: string) => string, now = () => Date.now()) {
  let candidates: { key: string; until: number; ids: string[] } | undefined;
  let loading: { key: string; value: Promise<string[]> } | undefined;
  async function categories(): Promise<CatalogCategories> {
    const rows: Row[] = [];
    let start: Record<string, unknown> | undefined;
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error('CATALOG_CATEGORY_LIMIT');
      const result = await db.send(new ScanCommand({ TableName: table('Category'), ConsistentRead: true,
        Limit: 250, ...projection(['id', 'name', 'isActive', 'deletedAt']), ExclusiveStartKey: start }));
      rows.push(...(result.Items ?? []));
      if (rows.length > 2000) throw new Error('CATALOG_CATEGORY_LIMIT');
      if (!result.LastEvaluatedKey) break;
      if (JSON.stringify(start) === JSON.stringify(result.LastEvaluatedKey)) throw new Error('CATALOG_CATEGORY_CURSOR');
      start = result.LastEvaluatedKey;
    }
    return catalogCategories(rows);
  }
  async function discover(categories: CatalogCategories): Promise<string[]> {
    const ids = [...categories.stages.keys()].sort();
    if (!ids.length) return [];
    const cacheKey = JSON.stringify(ids);
    if (candidates?.key === cacheKey && candidates.until > now()) return candidates.ids;
    if (loading?.key === cacheKey) return loading.value;
    const value = (async () => {
      const found = new Set<string>();
      let scanned = 0;
      await Promise.all(Array.from({ length: 4 }, async (_, segment) => {
        let start: Record<string, unknown> | undefined;
        for (let page = 0; ; page++) {
          if (page >= 30) throw new Error('CATALOG_DISCOVERY_LIMIT');
          const result = await db.send(new ScanCommand({ TableName: table('Inventory'), ConsistentRead: true, Limit: 1000,
            Segment: segment, TotalSegments: 4,
            ProjectionExpression: 'id',
            FilterExpression: ids.map((_, index) => `(contains(#categories, :c${index}) OR ((attribute_not_exists(#categories) OR attribute_type(#categories, :nullType)) AND #category = :c${index}))`).join(' OR '),
            ExpressionAttributeNames: { '#categories': 'categoryIds', '#category': 'categoryId' },
            ExpressionAttributeValues: { ...Object.fromEntries(ids.map((id, index) => [':c' + index, id])), ':nullType': 'NULL' }, ExclusiveStartKey: start,
          }));
          scanned += result.ScannedCount ?? result.Items?.length ?? 0;
          for (const row of result.Items ?? []) {
            if (typeof row.id !== 'string') throw new Error('CATALOG_DISCOVERY_INVALID');
            found.add(row.id);
          }
          if (scanned > 40000 || found.size > 5000) throw new Error('CATALOG_DISCOVERY_LIMIT');
          if (!result.LastEvaluatedKey) break;
          if (JSON.stringify(start) === JSON.stringify(result.LastEvaluatedKey)) throw new Error('CATALOG_DISCOVERY_CURSOR');
          start = result.LastEvaluatedKey;
        }
      }));
      const result = [...found];
      candidates = { key: cacheKey, until: now() + 15000, ids: result };
      return result;
    })();
    loading = { key: cacheKey, value };
    try { return await value; }
    finally { if (loading?.value === value) loading = undefined; }
  }
  async function rows(categories: CatalogCategories): Promise<Row[]> {
    const ids = await discover(categories);
    return [...(await readInventoryBatch(db, table('Inventory'), ids, undefined, CATALOG_ATTRIBUTES)).values()];
  }
  async function one(id: string): Promise<Row | null> {
    const response = await db.send(new GetCommand({ TableName: table('Inventory'), Key: { id }, ConsistentRead: true, ...projection(CATALOG_ATTRIBUTES) }));
    return response.Item ?? null;
  }
  async function byIds(ids: string[]): Promise<Row[]> {
    return [...(await readInventoryBatch(db, table('Inventory'), ids, undefined, CATALOG_ATTRIBUTES)).values()];
  }
  return { categories, rows, one, byIds };
}
