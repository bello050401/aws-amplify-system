import 'server-only';
import {BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb, inventoryTable} from '../inventory/categoryPersistence';
import {inventoryMutationSession} from '../inventory/mutationSession';

export type CurrentSaleSummary = {id: string; name?: string; salePrice?: number | null; saleCommission?: number | null; saleEndDate?: string | null; externalProductId?: string | null; deletedAt?: string | null};

/** Current values only, no cross-request cache. Null requests the existing
 * AppSync fallback; an incomplete batch must never look like deleted stock. */
export async function readCurrentSaleSummaryBatch(ids: string[]): Promise<Map<string, CurrentSaleSummary> | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  if (unique.length > 100 || unique.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) return null;
  if ((await inventoryMutationSession())?.role !== 'ADMIN') return null;
  try {
    const table = inventoryTable('Inventory');
    const fields = ['id','name','salePrice','saleCommission','saleEndDate','externalProductId','deletedAt'];
    const result = await inventoryDdb.send(new BatchGetCommand({RequestItems: {[table]: {
      Keys: unique.map(id => ({id})), ConsistentRead: true,
      ProjectionExpression: fields.map((_,n) => '#f'+n).join(','),
      ExpressionAttributeNames: Object.fromEntries(fields.map((field,n) => ['#f'+n,field])),
    }}}));
    if (Object.values(result.UnprocessedKeys ?? {}).some(group => group.Keys?.length)) return null;
    const rows = result.Responses?.[table];
    if (!Array.isArray(rows)) return null;
    if (rows.some(row => !unique.includes(row.id))) return null;
    return new Map(rows.map(row => [row.id, row as CurrentSaleSummary]));
  } catch { return null; }
}
