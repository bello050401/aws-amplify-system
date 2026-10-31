import 'server-only';
import { ScanCommand, type ScanCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { COMPACT_SEARCH_INDEX, supportsCompactSearch } from './compactSearchIndex';

/** Call only after the existing request-level role/device checks. No auth cache.
 * An index is eventually consistent: mutations still read the original item
 * consistently and compare versions. Index failure never becomes an empty list.
 */
export async function readCompactSearch(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  input: Pick<ScanCommandInput, 'TableName' | 'ProjectionExpression' | 'FilterExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'>,
  fields: readonly string[],
): Promise<Record<string, unknown>[] | null> {
  if (process.env.BELLO_COMPACT_SEARCH_INDEX !== '1' || !supportsCompactSearch(fields)) return null;
  try {
    const parts = await Promise.all(Array.from({length: 4}, async (_, segment) => {
      const rows: Record<string, unknown>[] = [];
      let key: ScanCommandInput['ExclusiveStartKey'];
      let pages = 0;
      do {
        const result = await client.send(new ScanCommand({ ...input,
          IndexName: COMPACT_SEARCH_INDEX, Segment: segment, TotalSegments: 4, ExclusiveStartKey: key,
        }));
        rows.push(...(result.Items ?? []));
        key = result.LastEvaluatedKey;
        if (++pages > 60 || rows.length >= 20000) throw new Error('SEARCH_LIMIT');
      } while (key);
      return rows;
    }));
    const rows = parts.flat();
    return rows.length >= 20000 ? null : rows;
  } catch {
    // Missing/backfilling index, denied IAM, throttling or partial reads: the
    // existing authoritative scan is the fallback, never a partial catalogue.
    return null;
  }
}
