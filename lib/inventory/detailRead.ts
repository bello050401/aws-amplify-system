import 'server-only';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient, GetCommand} from '@aws-sdk/lib-dynamodb';
import {directTableName} from '../amplify/directData';
import {inventoryVerifiedReadSession} from './mutationSession';

let client: DynamoDBDocumentClient | undefined;

/** A fresh, single-row read. Verify the signed Cognito token before using IAM;
 * decoded client claims and the mobile role check alone are not sufficient.
 * undefined means use the authenticated AppSync fallback, null means absent.
 * No product or authorization result is cached across requests. */
export async function readVerifiedInventoryDetail(id: string): Promise<Record<string, unknown> | null | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return undefined;
  if (!await inventoryVerifiedReadSession()) return undefined;
  try {
    client ??= DynamoDBDocumentClient.from(new DynamoDBClient({region: process.env.AWS_REGION || 'us-west-2'}));
    const result = await client.send(new GetCommand({
      TableName: directTableName('Inventory'), Key: {id}, ConsistentRead: true,
    }));
    if (!result.Item) return null;
    if (result.Item.id !== id) throw new Error('INVENTORY_IDENTITY_MISMATCH');
    return result.Item;
  } catch {
    // Preserve the existing authorization-enforced read during IAM outages.
    return undefined;
  }
}
