import 'server-only';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient, ScanCommand} from '@aws-sdk/lib-dynamodb';
import {directTableName} from '../amplify/directData';
import {inventoryVerifiedReadSession} from '../inventory/mutationSession';
import {cachedMaster} from '../inventory/masterCache';
import {listCategories, listLocations, listStatuses, type MasterOption, type StatusOption} from '../inventory/queries';
import {listCustomFieldDefinitions, toCustomFieldDefinitionRow, type CustomFieldDefinitionRow} from '../inventory/queries';

let client: DynamoDBDocumentClient | undefined;
type Master = 'Category' | 'Location' | 'StatusMaster';

/** Small shared masters only, never the inventory table. Preserve the existing
 * cache/invalidation and AppSync fallback. Verify the signed user token even
 * on a cache hit; an IAM read is not authorized by client-supplied role claims. */
async function activeRows(master: Master): Promise<Record<string, unknown>[]> {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({region: process.env.AWS_REGION || 'us-west-2'}));
  const rows: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: directTableName(master), ConsistentRead: true, ExclusiveStartKey: cursor,
      FilterExpression: '#active = :active', ExpressionAttributeValues: {':active': true},
      ProjectionExpression: master === 'StatusMaster' ? 'id, code, #label, sortOrder' : 'id, #label, parentId, sortOrder',
      ExpressionAttributeNames: {'#active': 'isActive', '#label': master === 'StatusMaster' ? 'label' : 'name'},
    }));
    rows.push(...(result.Items ?? [])); cursor = result.LastEvaluatedKey;
  } while (cursor);
  if (rows.some(row => typeof row.id !== 'string' || typeof row[master === 'StatusMaster' ? 'label' : 'name'] !== 'string' ||
    (master === 'StatusMaster' && typeof row.code !== 'string'))) throw new Error('INVALID_MASTER');
  return rows;
}

async function choices(master: 'Category' | 'Location', fallback: () => Promise<MasterOption[]>): Promise<MasterOption[]> {
  try {
    if (!await inventoryVerifiedReadSession()) return fallback();
    return (await cachedMaster(master, async () => (await activeRows(master)).map(row => ({
      id: row.id as string, name: row.name as string, parentId: typeof row.parentId === 'string' ? row.parentId : null,
      sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
    })).sort((a,b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ja')))).slice();
  } catch { return fallback(); }
}

export const listMobileEditCategories = () => choices('Category', listCategories);
export const listMobileEditLocations = () => choices('Location', listLocations);
export async function listMobileEditStatuses(): Promise<StatusOption[]> {
  try {
    if (!await inventoryVerifiedReadSession()) return listStatuses();
    return (await cachedMaster('StatusMaster', async () => (await activeRows('StatusMaster')).map(row => ({
      id: row.id as string, code: row.code as string, label: row.label as string,
      sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
    })).sort((a,b) => a.sortOrder - b.sortOrder))).slice();
  } catch { return listStatuses(); }
}

/** PC and mobile list/search reuse the same small-master fast path. No inventory
 * records or customer data are cached here. Each caller still checks its session. */
export const listFastCategories = listMobileEditCategories;
export const listFastLocations = listMobileEditLocations;
export const listFastStatuses = listMobileEditStatuses;
export async function listFastCustomFieldDefinitions(): Promise<CustomFieldDefinitionRow[]> {
  try {
    if (!await inventoryVerifiedReadSession()) return listCustomFieldDefinitions();
    return (await cachedMaster('CustomFieldDefinition', async () => {
      client ??= DynamoDBDocumentClient.from(new DynamoDBClient({region: process.env.AWS_REGION || 'us-west-2'}));
      const rows: CustomFieldDefinitionRow[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const result = await client.send(new ScanCommand({TableName:directTableName('CustomFieldDefinition'),
          ConsistentRead:true, ExclusiveStartKey:cursor,
          FilterExpression:'#active = :active',ExpressionAttributeValues:{':active':true},
          ProjectionExpression:'id, fieldKey, #label, fieldType, #required, sortOrder, #options, #active',
          ExpressionAttributeNames:{'#active':'isActive','#label':'label','#required':'required','#options':'options'},
        }));
        for (const row of result.Items ?? []) {
          if (typeof row.id!=='string'||typeof row.fieldKey!=='string'||typeof row.label!=='string'||
            !['TEXT','TEXTAREA','NUMBER','SELECT','DATE','URL'].includes(row.fieldType)) throw Error('INVALID_MASTER');
          rows.push(toCustomFieldDefinitionRow(row as Parameters<typeof toCustomFieldDefinitionRow>[0]));
        }
        cursor=result.LastEvaluatedKey;
      } while(cursor);
      return rows.sort((a,b)=>a.sortOrder-b.sortOrder);
    })).slice();
  } catch {return listCustomFieldDefinitions();}
}
