import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { createAnalysisMetadataStore } from '../analysis/metadata';
import { fields } from '../analysis/normalize';
import { inventoryCategoryIds } from '../categories';
import { CATEGORY_LIMIT } from '../editValidation';
import type { QuantityPlanningSettings, SavedQuantityPlan } from './contracts';
import { EMPTY_QUANTITY_SETTINGS, MAX_PLAN_BYTES, MAX_SETTINGS_BYTES, validRevision, validateSettings } from './settings';
import { fingerprint, sourceFromInventory, type CategorySource } from './source';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type Check = NonNullable<Write['ConditionCheck']>;
type Model = 'Inventory' | 'Category' | 'InventoryAnalysisMetadata' | 'InventoryHistory';
type Table = (model: Model) => string;
type Key = Record<string, string>;
type Version = { scope: string; id: string; revision: number };

const PLAN_SCOPE = 'quantity-plan';
const SETTINGS_SCOPE = 'quantity-settings';
const SETTINGS_KEY = { scope: SETTINGS_SCOPE, id: 'current' };
const INVENTORY_FIELDS = ['id', 'name', 'categoryId', 'categoryIds', 'quantity', 'purchasePrice', 'plannedSalePrice', 'width', 'depth',
  'customFields', 'revision', 'updatedAt', 'deletedAt', 'saleEndDate', 'externalProductId'];

function expectRevision(revision: number) {
  return revision
    ? { ConditionExpression: '#rev = :rev', ExpressionAttributeNames: { '#rev': 'revision' }, ExpressionAttributeValues: { ':rev': revision } }
    : { ConditionExpression: 'attribute_not_exists(id)' };
}

function readJson(item: Record<string, unknown>, limit: number) {
  if (!validRevision(item.revision) || item.revision === 0 ||
      typeof item.valueJson !== 'string' || Buffer.byteLength(item.valueJson) > limit) throw new Error('QUANTITY_METADATA_INVALID');
  return JSON.parse(item.valueJson) as unknown;
}

export function isWriteConflict(error: unknown): boolean {
  const record = fields(error);
  return record?.name === 'ConditionalCheckFailedException' || record?.name === 'TransactionConflictException' ||
    (record?.name === 'TransactionCanceledException' && Array.isArray(record.CancellationReasons) &&
      record.CancellationReasons.some(reason => fields(reason)?.Code === 'ConditionalCheckFailed' || fields(reason)?.Code === 'TransactionConflict'));
}

export function createQuantityPlanningStore(db: Db, table: Table) {
  const metadataTable = () => table('InventoryAnalysisMetadata');
  const classification = (inventoryId?: string) => createAnalysisMetadataStore(db, metadataTable()).quantityClassification(inventoryId);
  const planKey = (id: string) => ({ scope: PLAN_SCOPE, id });
  async function get(model: Model, key: Key, projection?: string[]) {
    const names = projection?.map((name, i) => [`#f${i}`, name]);
    return (await db.send(new GetCommand({
      TableName: table(model), Key: key, ConsistentRead: true,
      ...(names ? { ProjectionExpression: names.map(([name]) => name).join(', '), ExpressionAttributeNames: Object.fromEntries(names) } : {}),
    }))).Item;
  }

  async function getSettings() {
    const item = await get('InventoryAnalysisMetadata', SETTINGS_KEY);
    if (!item) return { revision: 0, settings: EMPTY_QUANTITY_SETTINGS };
    const settings = readJson(item, MAX_SETTINGS_BYTES);
    if (!validateSettings(settings)) throw new Error('QUANTITY_SETTINGS_INVALID');
    return { revision: item.revision as number, settings };
  }

  async function getPlan(id: string) {
    const item = await get('InventoryAnalysisMetadata', planKey(id));
    if (!item) return null;
    const value = fields(readJson(item, MAX_PLAN_BYTES));
    const calculation = fields(value?.calculation);
    if (!value || value.inventoryId !== id || value.revision !== item.revision || !fields(value.conditions) ||
        calculation?.ok !== true || !fields(calculation.plan) ||
        typeof value.calculatedAt !== 'string' || typeof value.calculatedBy !== 'string' ||
        typeof value.logicVersion !== 'string' || !validRevision(value.settingsVersion) ||
        typeof value.sourceFingerprint !== 'string') throw new Error('QUANTITY_PLAN_INVALID');
    const { sourceFingerprint, ...plan } = value as StoredQuantityPlan;
    return { sourceFingerprint, plan };
  }

  async function readSource(id: string) {
    const row = await get('Inventory', { id }, INVENTORY_FIELDS);
    if (!row || row.deletedAt) return null;
    const [product, workflow] = await Promise.all([
      classification(id),
      Promise.all(inventoryCategoryIds({
        categoryId: typeof row.categoryId === 'string' ? row.categoryId : null,
        categoryIds: Array.isArray(row.categoryIds) ? row.categoryIds : null,
      }).slice(0, CATEGORY_LIMIT).filter(key => key.length <= 128).map(async key => {
        const category = await get('Category', { id: key }, ['id', 'name']);
        return { id: key, name: typeof category?.name === 'string' ? category.name : null };
      })),
    ]);
    return { ...sourceFromInventory(row, product, workflow), versions: product.versions };
  }

  function metadataCheck(key: Key, revision: number): Write {
    return { ConditionCheck: { TableName: metadataTable(), Key: key, ...expectRevision(revision) } };
  }

  function inventoryCheck(row: Record<string, unknown>, id: string): Write {
    const rules = ['attribute_exists(id)', '(attribute_not_exists(deletedAt) OR deletedAt = :null)'];
    const names: NonNullable<Check['ExpressionAttributeNames']> = {};
    const values: NonNullable<Check['ExpressionAttributeValues']> = { ':null': null };
    // Legacy jobs can write within the same millisecond and may omit revision.
    // Match the calculation inputs as well as the available version values.
    for (const key of INVENTORY_FIELDS.filter(field => field !== 'id' && field !== 'deletedAt')) {
      names['#' + key] = key;
      rules.push(row[key] === undefined ? `attribute_not_exists(#${key})` : `#${key} = :${key}`);
      if (row[key] !== undefined) values[':' + key] = row[key];
    }
    return { ConditionCheck: {
      TableName: table('Inventory'), Key: { id }, ConditionExpression: rules.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    } };
  }

  function categoryCheck({ id, name }: CategorySource): Write {
    return { ConditionCheck: {
      TableName: table('Category'), Key: { id },
      ...(name === null ? { ConditionExpression: 'attribute_not_exists(#name) OR #name = :name' } : { ConditionExpression: '#name = :name' }),
      ExpressionAttributeNames: { '#name': 'name' }, ExpressionAttributeValues: { ':name': name },
    } };
  }

  const historyId = (id: string, operationId: string) => 'quantity-plan:' + fingerprint([id, operationId]);

  async function getReceipt(id: string, operationId: string) {
    const row = await get('InventoryHistory', { id: historyId(id, operationId) }, ['id', 'inventoryId', 'quantityRequestHash', 'quantityPlanRevision']);
    if (!row) return null;
    if (row.inventoryId !== id || typeof row.quantityRequestHash !== 'string' ||
        !validRevision(row.quantityPlanRevision)) throw new Error('QUANTITY_RECEIPT_INVALID');
    return { requestHash: row.quantityRequestHash, revision: row.quantityPlanRevision };
  }

  async function putPlan(data: {
    value: StoredQuantityPlan;
    operationId: string;
    requestHash: string;
    before: SavedQuantityPlan | null;
    source: NonNullable<Awaited<ReturnType<typeof readSource>>>;
  }) {
    const { value, operationId, requestHash, before, source } = data;
    const now = value.calculatedAt;
    const id = value.inventoryId;
    const valueJson = JSON.stringify(value);
    if (Buffer.byteLength(valueJson) > MAX_PLAN_BYTES) throw new Error('QUANTITY_PLAN_TOO_LARGE');
    const { retailQuantity, wholesaleQuantity } = value.calculation.plan.recommended;
    await db.send(new TransactWriteCommand({ TransactItems: [
      inventoryCheck(source.row, id),
      metadataCheck(SETTINGS_KEY, value.settingsVersion),
      ...source.versions.map(({ revision, ...key }) => metadataCheck(key, revision)),
      ...source.workflow.map(categoryCheck),
      { Put: {
        TableName: metadataTable(), ...expectRevision(before?.revision ?? 0),
        Item: { ...planKey(id), valueJson, revision: value.revision, changedBy: value.calculatedBy,
          changedAt: now, updatedAt: now, createdAt: before?.calculatedAt ?? now, __typename: 'InventoryAnalysisMetadata' },
      } },
      { Put: {
        TableName: table('InventoryHistory'), ConditionExpression: 'attribute_not_exists(id)',
        Item: { id: historyId(id, operationId), inventoryId: id, changedAt: now, changedBy: value.calculatedBy,
          fieldName: '適正数量の計算', oldValue: before ? historySummary(before) : null,
          newValue: `通常販売 ${retailQuantity}個、業販 ${wholesaleQuantity}個（第${value.revision}版）`,
          quantityRequestHash: requestHash, quantityPlanRevision: value.revision,
          createdAt: now, updatedAt: now, __typename: 'InventoryHistory' },
      } },
    ] }));
  }

  async function putSettings(settings: QuantityPlanningSettings, expectedRevision: number, taxonomy: Version, actor: string, now: string) {
    await db.send(new TransactWriteCommand({ TransactItems: [
      metadataCheck({ scope: taxonomy.scope, id: taxonomy.id }, taxonomy.revision),
      { Put: {
        TableName: metadataTable(), ...expectRevision(expectedRevision),
        Item: { ...SETTINGS_KEY, valueJson: JSON.stringify(settings), revision: expectedRevision + 1,
          changedBy: actor, changedAt: now, updatedAt: now, createdAt: now, __typename: 'InventoryAnalysisMetadata' },
      } },
    ] }));
  }

  return { classification, getPlan, getSettings, getReceipt, readSource, putPlan, putSettings };
}

export type QuantityPlanningStore = ReturnType<typeof createQuantityPlanningStore>;
export type StoredQuantityPlan = SavedQuantityPlan & { sourceFingerprint: string };

function historySummary(plan: SavedQuantityPlan) {
  const { retailQuantity, wholesaleQuantity } = plan.calculation.plan.recommended;
  return `通常販売 ${retailQuantity}個、業販 ${wholesaleQuantity}個（第${plan.revision}版）`;
}
