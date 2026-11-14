import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { fields, productCategories, sourceKey } from './normalize';
import { dateOnly } from './period';
import type { Confirmation, Evidence, Metadata, MetadataRow, ProductCategory } from './types';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
export type MetadataSaveRequest = { [Type in Metadata['type']]: {
  type: Type; value: Extract<Metadata, { type: Type }>; expectedRevision: number;
} }[Metadata['type']];
export type MetadataSaveResult = { status: 'ok'; revision: number; rebuildRequired: true } | { status: 'conflict' | 'invalid' | 'error' };

const defaultCategories: ProductCategory[] = [
  { id: 'sofa', label: 'ソファ' }, { id: 'dining-chair', label: 'ダイニングチェア' },
  { id: 'personal-chair', label: 'パーソナルチェア' }, { id: 'work-chair', label: 'ワークチェア' },
  { id: 'stool', label: 'スツール' }, { id: 'table-desk', label: 'テーブル・デスク' },
  { id: 'bench-ottoman', label: 'ベンチ・オットマン' }, { id: 'storage', label: '収納家具' },
  { id: 'lighting', label: '照明' }, { id: 'interior-art', label: 'インテリア・アート' },
  { id: 'other', label: 'その他商品' },
];
const initialTaxonomy: MetadataRow = { id: 'taxonomy', revision: 1, value: { type: 'taxonomy', categories: defaultCategories } };
const MAX_ROWS = 20_000;
const CURRENT = 'current';
const CONTROL = 'control';
const EPOCH = 'epoch';
const MAX_REVISION = 2_147_483_647;
const MAX_VALUE_BYTES = 24 * 1024;

const label = (value: unknown, max = 120): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const simpleId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const reference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.!~*'()%:-]{1,240}$/.test(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is number => natural(value) && value <= MAX_REVISION;
const state = (value: unknown): value is Confirmation => value === 'confirmed' || value === 'candidate' || value === 'unknown';
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const nullableId = (value: unknown): value is string | null => value === null || simpleId(value);

function validEvidence(value: unknown): value is Evidence | null {
  if (value === null) return true;
  const record = fields(value);
  return !!record && keys(record, ['source', 'recordId']) && label(record.source, 80) && label(record.recordId, 180);
}

function validateValue(value: unknown): value is Metadata {
  const row = fields(value);
  if (!row) return false;
  switch (row.type) {
    case 'taxonomy':
      if (!keys(row, ['type', 'categories']) || !Array.isArray(row.categories) || row.categories.length < 1 || row.categories.length > 100) return false;
      return row.categories.every(entry => {
        const category = fields(entry);
        return category && keys(category, ['id', 'label'], ['mergedInto']) && simpleId(category.id) &&
          label(category.label) && (category.mergedInto === undefined || simpleId(category.mergedInto));
      });
    case 'kind': {
      if (!keys(row, ['type', 'id', 'state', 'modelId', 'categoryId', 'specification']) || !simpleId(row.id) || !state(row.state) ||
          !(row.modelId === null || simpleId(row.modelId)) || !nullableId(row.categoryId)) return false;
      const spec = fields(row.specification);
      const parts = ['brand', 'model', 'color', 'material', 'size', 'saleUnit'];
      return !!spec && keys(spec, parts) && parts.every(part =>
        label(spec[part]) || (row.state !== 'confirmed' && spec[part] === ''));
    }
    case 'inventory':
      return keys(row, ['type', 'inventoryId', 'categoryId', 'categoryState', 'kindId', 'kindState', 'lotId', 'lotState',
        'salesQuantity', 'salesQuantityEvidence', 'retail', 'saleCostTotal', 'saleCostEvidence']) &&
        simpleId(row.inventoryId) && nullableId(row.categoryId) && state(row.categoryState) && nullableId(row.kindId) && state(row.kindState) &&
        (row.lotId === null || reference(row.lotId)) && state(row.lotState) &&
        (row.categoryState !== 'confirmed' || row.categoryId !== null) && (row.kindState !== 'confirmed' || row.kindId !== null) &&
        (row.lotState !== 'confirmed' || row.lotId !== null) &&
        (row.salesQuantity === null || (natural(row.salesQuantity) && row.salesQuantity > 0)) && validEvidence(row.salesQuantityEvidence) &&
        (row.salesQuantity === null) === (row.salesQuantityEvidence === null) &&
        (row.saleCostTotal === null || natural(row.saleCostTotal)) && validEvidence(row.saleCostEvidence) &&
        (row.saleCostTotal === null) === (row.saleCostEvidence === null) &&
        (row.retail === 'confirmed' || row.retail === 'unknown' || row.retail === 'excluded');
    case 'lot':
      if (!keys(row, ['type', 'id', 'source', 'sourceRecordId', 'state', 'date', 'quantity', 'costTotal', 'categoryId', 'kindId',
        'merchandise', 'operation', 'originalLotId']) || !reference(row.id) || !label(row.source, 80) || !label(row.sourceRecordId, 180) ||
        row.id !== sourceKey(row.source, row.sourceRecordId) || !state(row.state) || typeof row.date !== 'string' ||
        (row.quantity !== null && (!natural(row.quantity) || row.quantity === 0)) || (row.costTotal !== null && !natural(row.costTotal)) ||
        !nullableId(row.categoryId) || !nullableId(row.kindId) || typeof row.merchandise !== 'boolean') return false;
      try { dateOnly(row.date); } catch { return false; }
      if (row.operation === 'acquisition') return row.originalLotId === null;
      return (row.operation === 'return' || row.operation === 'cancellation') && reference(row.originalLotId) && row.originalLotId !== row.id;
    default:
      return false;
  }
}

const metadataId = (value: Metadata) =>
  value.type === 'taxonomy' ? 'taxonomy' : value.type === 'inventory' ? 'inventory:' + value.inventoryId : value.type + ':' + value.id;

function parseRow(item: Record<string, unknown>): MetadataRow {
  if (typeof item.id !== 'string' || !revision(item.revision) || item.revision === 0 ||
      typeof item.valueJson !== 'string' || Buffer.byteLength(item.valueJson) > MAX_VALUE_BYTES) throw new Error('ANALYSIS_METADATA_INVALID');
  const value: unknown = JSON.parse(item.valueJson);
  if (!validateValue(value) || metadataId(value) !== item.id) throw new Error('ANALYSIS_METADATA_INVALID');
  return { id: item.id, revision: item.revision, value };
}

export function createAnalysisMetadataStore(db: Db, table: string) {
  async function get(scope: string, id: string) {
    return (await db.send(new GetCommand({ TableName: table, Key: { scope, id }, ConsistentRead: true }))).Item;
  }

  async function epoch(): Promise<number> {
    const item = await get(CONTROL, EPOCH);
    if (!item) return 0;
    if (!revision(item.revision) || item.revision === 0) throw new Error('ANALYSIS_METADATA_EPOCH');
    return item.revision;
  }

  async function taxonomy() {
    const item = await get(CURRENT, 'taxonomy');
    return item ? parseRow(item) : initialTaxonomy;
  }

  async function queryCurrent(prefix?: string, start?: string, limit = 500) {
    return db.send(new QueryCommand({
      TableName: table, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: '#scope = :scope' + (prefix ? ' AND begins_with(id, :prefix)' : ''),
      ExpressionAttributeNames: { '#scope': 'scope' },
      ExpressionAttributeValues: { ':scope': CURRENT, ...(prefix ? { ':prefix': prefix } : {}) },
      ExclusiveStartKey: start ? { scope: CURRENT, id: start } : undefined,
    }));
  }

  async function forRebuild() {
    const before = await epoch();
    let key: string | undefined;
    const rows: MetadataRow[] = [];
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('ANALYSIS_METADATA_LIMIT');
      const response = await queryCurrent(undefined, key);
      for (const item of response.Items ?? []) rows.push(parseRow(item));
      if (rows.length > MAX_ROWS) throw new Error('ANALYSIS_METADATA_LIMIT');
      const next = response.LastEvaluatedKey?.id;
      if (typeof next !== 'string') break;
      if (next === key) throw new Error('ANALYSIS_METADATA_PAGING');
      key = next;
    }
    if (before !== await epoch()) throw new Error('ANALYSIS_METADATA_CHANGED');
    if (!rows.some(row => row.id === 'taxonomy')) rows.push(initialTaxonomy);
    return { rows, epoch: before };
  }

  async function inspect(inventoryId?: string) {
    if (inventoryId !== undefined && !simpleId(inventoryId)) return { status: 'error' as const };
    const [categories, current] = await Promise.all([
      taxonomy(), inventoryId === undefined ? undefined : get(CURRENT, 'inventory:' + inventoryId),
    ]);
    if (categories.value.type !== 'taxonomy') throw new Error('ANALYSIS_METADATA_INVALID');
    return { status: 'ok' as const, categories: categories.value.categories, taxonomyRevision: categories.revision, current: current ? parseRow(current) : null };
  }

  async function quantityClassification(inventoryId?: string) {
    const inventoryKey = inventoryId === undefined ? undefined : 'inventory:' + inventoryId;
    const [taxItem, inventoryItem] = await Promise.all([
      get(CURRENT, 'taxonomy'), inventoryKey ? get(CURRENT, inventoryKey) : undefined,
    ]);
    const tax = taxItem ? parseRow(taxItem) : initialTaxonomy;
    const inventory = inventoryItem ? parseRow(inventoryItem) : null;
    const inventoryValue = inventory?.value.type === 'inventory' ? inventory.value : null;
    const kindKey = inventoryValue?.kindState === 'confirmed' && inventoryValue.kindId ? 'kind:' + inventoryValue.kindId : null;
    const kindItem = kindKey ? await get(CURRENT, kindKey) : undefined;
    const kind = kindItem ? parseRow(kindItem) : null;
    return {
      taxonomy: productCategories([tax]),
      inventory: inventoryValue,
      kind: kind?.value.type === 'kind' && kind.value.state === 'confirmed' ? kind.value : null,
      versions: [
        { scope: CURRENT, id: 'taxonomy', revision: taxItem ? tax.revision : 0 },
        ...(inventoryKey ? [{ scope: CURRENT, id: inventoryKey, revision: inventory?.revision ?? 0 }] : []),
        ...(kindKey ? [{ scope: CURRENT, id: kindKey, revision: kind?.revision ?? 0 }] : []),
      ],
    };
  }

  async function list(type: 'kind' | 'lot', cursor?: string) {
    if ((type !== 'kind' && type !== 'lot') || (cursor !== undefined && (!reference(cursor) || !cursor.startsWith(type + ':')))) return { status: 'error' as const };
    const page = await queryCurrent(type + ':', cursor, 25);
    return { status: 'ok' as const, rows: (page.Items ?? []).map(parseRow), nextCursor: (page.LastEvaluatedKey?.id as string | undefined) ?? null };
  }

  async function save(input: unknown, actor: string, inventoryTable: () => string, now = new Date().toISOString()): Promise<MetadataSaveResult> {
    const request = fields(input);
    if (!request || !keys(request, ['type', 'value', 'expectedRevision']) || !revision(request.expectedRevision) ||
        !validateValue(request.value) || request.type !== request.value.type || !label(actor, 250)) return { status: 'invalid' };
    const value = request.value;
    const id = metadataId(value);
    const valueJson = JSON.stringify(value);
    if (Buffer.byteLength(valueJson) > MAX_VALUE_BYTES) return { status: 'invalid' };
    const previousEpoch = await epoch();
    const [prior, tax] = await Promise.all([get(CURRENT, id), taxonomy()]);
    const priorRevision = prior ? parseRow(prior).revision : value.type === 'taxonomy' ? initialTaxonomy.revision : 0;
    if (priorRevision !== request.expectedRevision) return { status: 'conflict' };
    if (priorRevision === MAX_REVISION || previousEpoch === MAX_REVISION) return { status: 'error' };

    if (tax.value.type !== 'taxonomy') throw new Error('ANALYSIS_METADATA_INVALID');
    if (value.type === 'taxonomy') {
      // Existing classifications survive a rename or merge through their old IDs.
      if (tax.value.categories.some(category => !value.categories.some(next => next.id === category.id))) return { status: 'invalid' };
      try { productCategories([{ id, revision: priorRevision + 1, value }]); } catch { return { status: 'invalid' }; }
    } else {
      if (value.categoryId !== null && !tax.value.categories.some(category => category.id === value.categoryId)) return { status: 'invalid' };
      if ('kindId' in value && value.kindId !== null) {
        const item = await get(CURRENT, 'kind:' + value.kindId);
        if (!item) return { status: 'invalid' };
        const kind = parseRow(item).value;
        if (kind.type !== 'kind' || (value.type === 'inventory' && value.kindState === 'confirmed' && kind.state !== 'confirmed')) return { status: 'invalid' };
      }
      const lotId = value.type === 'inventory' ? value.lotId : value.type === 'lot' ? value.originalLotId : null;
      if (lotId !== null) {
        const item = await get(CURRENT, 'lot:' + lotId);
        if (!item) return { status: 'invalid' };
        const lot = parseRow(item).value;
        if (lot.type !== 'lot' || (value.type === 'inventory' && value.lotState === 'confirmed' && lot.state !== 'confirmed') ||
            (value.type === 'lot' && (lot.operation !== 'acquisition' || lot.source !== value.source || lot.date > value.date))) return { status: 'invalid' };
      }
    }

    const next = priorRevision + 1;
    const item = { id, revision: next, metadataEpoch: previousEpoch + 1, valueJson, changedBy: actor, changedAt: now, updatedAt: now };
    const tryPut = {
      TableName: table,
      ConditionExpression: prior ? 'revision = :prior' : 'attribute_not_exists(id)',
      ...(prior ? { ExpressionAttributeValues: { ':prior': priorRevision } } : {}),
    };
    const checks = value.type === 'inventory' ? [{ ConditionCheck: {
      TableName: inventoryTable(), Key: { id: value.inventoryId }, ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(deletedAt) OR deletedAt = :null)',
      ExpressionAttributeValues: { ':null': null },
    } }] : [];
    try {
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { ...tryPut, Item: { ...item, scope: CURRENT, createdAt: prior?.createdAt ?? now } } },
        { Put: { TableName: table, Item: { ...item, scope: 'audit:' + id, id: String(next).padStart(10, '0'), createdAt: now }, ConditionExpression: 'attribute_not_exists(id)' } },
        { Put: {
          TableName: table, Item: { scope: CONTROL, id: EPOCH, revision: previousEpoch + 1, updatedAt: now },
          ConditionExpression: previousEpoch ? 'revision = :prior' : 'attribute_not_exists(id)',
          ...(previousEpoch ? { ExpressionAttributeValues: { ':prior': previousEpoch } } : {}),
        } },
        ...checks,
      ] }));
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        if (error.CancellationReasons?.[3]?.Code === 'ConditionalCheckFailed') return { status: 'invalid' };
        if (error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict')) return { status: 'conflict' };
      }
      throw error;
    }
    return { status: 'ok', revision: next, rebuildRequired: true };
  }

  return { forRebuild, inspect, list, save, quantityClassification };
}
