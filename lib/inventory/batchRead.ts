import 'server-only';
import { BatchGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Caller must authorize access first. Read only the requested inventory IDs,
 * consistently; an exhausted retry is an error, never a partial success. */
export async function readInventoryBatch(
  db: Pick<DynamoDBDocumentClient, 'send'>,
  table: string,
  ids: readonly string[],
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    let pending = unique.slice(offset, offset + 100).map(id => ({id}));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt >= 5) throw Error('INVENTORY_BATCH_READ_INCOMPLETE');
      if (attempt) await pause(Math.min(800, 50 * 2 ** (attempt - 1)));
      const requested = new Set(pending.map(key => key.id));
      const result = await db.send(new BatchGetCommand({RequestItems: {
        [table]: {Keys: pending, ConsistentRead: true},
      }}));
      for (const row of result.Responses?.[table] ?? []) {
        if (typeof row.id !== 'string' || !requested.has(row.id)) throw Error('INVENTORY_BATCH_READ_UNEXPECTED_ROW');
        found.set(row.id, row);
      }
      pending = (result.UnprocessedKeys?.[table]?.Keys ?? []).map(key => {
        if (typeof key.id !== 'string' || !requested.has(key.id)) throw Error('INVENTORY_BATCH_READ_UNEXPECTED_KEY');
        return {id: key.id};
      });
    }
  }
  return found;
}
