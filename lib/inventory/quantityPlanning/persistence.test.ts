import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { QuantityAreaStandard, QuantityPlanningConditions, QuantityPlanningSettings } from './contracts';
import { createQuantityPlanningService, type QuantityPlanningAccess } from './service';
import { createQuantityPlanningStore } from './store';

type Row = Record<string, unknown>;
type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
const key = (table: string, row: Row) => [table, row.scope ?? '', row.id].join('/');
const conditionFailed = () => Object.assign(new Error('transaction canceled'), {
  name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
});

/** In-memory command port, including the transactional compare-and-swap. */
class Database {
  rows = new Map<string, Row>();
  writes: Write[][] = [];
  reads = 0;
  afterCommit: (() => void) | null = null;
  beforeCompare: (() => void) | null = null;

  set(table: string, row: Row) { this.rows.set(key(table, row), structuredClone(row)); }
  get(table: string, row: Row) { return this.rows.get(key(table, row)); }

  send = (async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) {
      this.reads++;
      assert.equal(command.input.ConsistentRead, true);
      const row = this.get(command.input.TableName!, command.input.Key!);
      const projection = command.input.ExpressionAttributeNames;
      return { Item: !row || !projection ? structuredClone(row) : Object.fromEntries(Object.values(projection)
        .filter(name => Object.hasOwn(row, name)).map(name => [name, structuredClone(row[name])])) };
    }
    assert.ok(command instanceof TransactWriteCommand);
    const writes = command.input.TransactItems!;
    const before = this.beforeCompare;
    this.beforeCompare = null;
    before?.();
    for (const write of writes) {
      assert.ok(!write.Update && !write.Delete, 'quantity planning must never alter stock');
      const operation = write.Put ?? write.ConditionCheck!;
      const row = this.get(operation.TableName!, write.Put ? write.Put.Item! : write.ConditionCheck!.Key!);
      const names = operation.ExpressionAttributeNames ?? {};
      const values = operation.ExpressionAttributeValues ?? {};
      const exists = (field: string) => !!row && Object.hasOwn(row, names[field] ?? field);
      const equal = (field: string, pointer: string) => JSON.stringify(row?.[names[field] ?? field]) === JSON.stringify(values[pointer]);
      const evaluate = (term: string): boolean => {
        const missing = /^attribute_not_exists\(([^)]+)\)$/.exec(term);
        if (missing) return !exists(missing[1]);
        const present = /^attribute_exists\(([^)]+)\)$/.exec(term);
        if (present) return exists(present[1]);
        const comparison = /^(\S+) = (:\w+)$/.exec(term);
        assert.ok(comparison, term);
        return equal(comparison[1], comparison[2]);
      };
      const matches = operation.ConditionExpression!.split(' AND ').every(term =>
        term.replace(/^\((.*)\)$/, '$1').split(' OR ').some(evaluate));
      if (!matches) throw conditionFailed();
    }
    for (const { Put } of writes) {
      if (!Put) continue;
      assert.notEqual(Put.TableName, 'Inventory');
      this.set(Put.TableName!, Put.Item!);
    }
    this.writes.push(writes);
    const receipt = this.afterCommit;
    this.afterCommit = null;
    receipt?.();
    return {};
  }) as Pick<DynamoDBDocumentClient, 'send'>['send'];
}

const stock = {
  id: 'chair-1', name: '商品', quantity: 8, purchasePrice: 3500, plannedSalePrice: 21000,
  salePrice: 99000, saleCommission: 2000, shippingCost: 1600, purchaseQuantity: 11,
  categoryId: 'workflow', updatedAt: '2026-11-14T00:00:00.000Z', revision: 9,
  width: '650 mm', depth: '1m', images: [{ storageKey: 'keep-me' }],
  editHistory: { cursor: 1, entries: ['keep me'] }, customFields: '{"belloBrand":"メーカー"}',
};
const conditions: QuantityPlanningConditions = {
  saleMonths: '0.5', saleCount: 2, maintenanceMinutes: 0, storageMethod: 'flat', manualPlannedUnitPriceYen: null,
};
const settings: QuantityPlanningSettings = { flatAllowancePercent: 10, standards: [], expenses: [], remainingWork: [] };
const standard: QuantityAreaStandard = {
  categoryId: 'dining-chair', method: 'stack', source: 'measured-category', areaM2PerBlock: 0.85, unitsPerBlock: 4,
  reference: '実測パレット', disassemblyMinutes: null, reassemblyMinutes: null,
};
const inventoryMeta = {
  type: 'inventory', inventoryId: stock.id, categoryId: 'dining-chair', categoryState: 'confirmed',
  kindId: null, kindState: 'unknown', lotId: null, lotState: 'unknown',
  salesQuantity: null, salesQuantityEvidence: null, retail: 'unknown', saleCostTotal: null, saleCostEvidence: null,
};
const operationId = 'a8c03c04-4200-4472-9d35-887e0a57e786';

function context() {
  const db = new Database();
  const store = createQuantityPlanningStore(db, name => name);
  let access: QuantityPlanningAccess | null = { owner: 'verified-admin', role: 'ADMIN' };
  const service = createQuantityPlanningService({
    authorize: async () => access,
    canEdit: role => role === 'ADMIN' || role === 'EDITOR',
    store,
    now: () => '2026-11-14T04:00:00.000Z',
  });
  db.set('Inventory', stock);
  db.set('Category', { id: stock.categoryId, name: '撮影待ち' });
  db.set('InventoryAnalysisMetadata', { scope: 'current', id: 'inventory:' + stock.id, revision: 1, valueJson: JSON.stringify(inventoryMeta) });
  return { db, service, store, use: (value: QuantityPlanningAccess | null) => { access = value; } };
}

async function makeRequest(service: ReturnType<typeof createQuantityPlanningService>, conditionsValue = conditions, id = operationId) {
  const calculation = await service.calculate(stock.id, conditionsValue);
  assert.equal(calculation.status, 'ok');
  assert.ok(calculation.calculation.ok);
  assert.ok(calculation.token);
  return { conditions: conditionsValue, token: calculation.token, operationId: id };
}

test('requires authorized viewer for reads and editor for plan writes; settings are administrative', async () => {
  const { db, service, use } = context();
  use(null);
  assert.equal((await service.read(stock.id)).status, 'forbidden');
  assert.equal((await service.calculate(stock.id, conditions)).status, 'forbidden');
  assert.equal(db.reads, 0);
  use({ role: 'VIEWER', owner: 'verified-reader' });
  const viewer = await service.read(stock.id);
  assert.equal(viewer.status, 'ok');
  assert.equal(viewer.canEdit, false);
  const calculation = await service.calculate(stock.id, conditions);
  assert.equal(calculation.status, 'ok');
  assert.equal(calculation.token, null);
  assert.equal((await service.save(stock.id, {})).status, 'forbidden');
  assert.equal((await service.readSettings()).status, 'forbidden');
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings })).status, 'forbidden');
  use({ role: 'EDITOR', owner: 'verified-editor' });
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings })).status, 'forbidden');
  const request = await makeRequest(service);
  assert.equal((await service.save(stock.id, request, false)).status, 'forbidden');
  assert.equal((await service.save(stock.id, { ...request, actor: 'claimed-admin' })).status, 'invalid');
  assert.equal(db.writes.length, 0);
  const result = await service.save(stock.id, request);
  assert.equal(result.status, 'ok');
  assert.equal(result.latest?.calculatedBy, 'verified-editor');
});

test('normalizes current stock, preserves explicit zeros, uses measured standards before provisional and omits historical fees', async () => {
  const { db, service } = context();
  const saved = await service.saveSettings({ expectedRevision: 0, expectedTaxonomyRevision: 0, settings: {
    ...settings,
    standards: [{ ...standard, source: 'provisional-category', areaM2PerBlock: 200 }, standard],
  } });
  assert.equal(saved.status, 'ok');
  const stacked = await service.calculate(stock.id, { ...conditions, storageMethod: 'stack' });
  assert.equal(stacked.status, 'ok');
  assert.equal(stacked.source.quantity, 8);
  assert.equal(stacked.source.purchaseTotalYen, 28000);
  assert.equal(stacked.source.plannedUnitPriceYen, 21000);
  assert.equal(stacked.source.brand, 'メーカー');
  assert.equal(stacked.source.categoryName, 'ダイニングチェア');
  assert.equal(stacked.source.workflowCategoryName, '撮影待ち');
  assert.ok(stacked.calculation.ok);
  assert.equal(stacked.calculation.plan.inputs.area.source, 'measured-category');
  assert.equal(stacked.calculation.plan.recommended.maxAreaM2, 1.7);
  assert.ok(stacked.calculation.plan.recommended.expenseItems.every(item => item.status === 'unpriced'));
  const flat = await service.calculate(stock.id, conditions);
  assert.equal(flat.status, 'ok');
  assert.ok(flat.calculation.ok);
  assert.equal(Number(flat.calculation.plan.inputs.area.areaM2PerBlock), 0.715);
  assert.equal(flat.calculation.plan.inputs.area.source, 'inventory');
  db.set('Inventory', { ...stock, purchasePrice: 0, plannedSalePrice: 0 });
  const zero = await service.calculate(stock.id, { ...conditions, manualPlannedUnitPriceYen: 2000 });
  assert.equal(zero.status, 'ok');
  assert.ok(zero.calculation.ok);
  assert.equal(zero.source.purchaseTotalYen, 0);
  assert.equal(zero.calculation.plan.inputs.plannedUnitPriceYen, 0);
  assert.equal(zero.calculation.plan.inputs.plannedPriceSource, 'registered');
  db.set('Inventory', { ...stock, purchasePrice: null, plannedSalePrice: null });
  const missing = await service.calculate(stock.id, conditions);
  assert.equal(missing.status, 'ok');
  assert.equal(missing.source.purchaseTotalYen, null);
  assert.equal(missing.source.plannedUnitPriceYen, null);
  assert.deepEqual(missing.calculation, { ok: false, issues: [
    { field: 'purchaseUnitPriceYen', reason: 'missing' }, { field: 'plannedUnitPriceYen', reason: 'missing' },
  ] });
  db.set('Inventory', { ...stock, purchasePrice: 2.5, width: '60～70cm', depth: '0.7×1m' });
  const malformed = await service.calculate(stock.id, conditions);
  assert.equal(malformed.status, 'ok');
  assert.equal(malformed.source.purchaseUnitPriceYen, null);
  assert.ok(!malformed.calculation.ok && malformed.calculation.issues.some(item => item.field === 'area'));
});

test('lost response and repeat requests produce one immutable audit while keeping one latest plan', async () => {
  const { db, service, store } = context();
  db.set('Inventory', { ...stock, plannedSalePrice: null });
  const before = structuredClone(db.get('Inventory', stock));
  const manual = { ...conditions, manualPlannedUnitPriceYen: '5000' };
  const request = await makeRequest(service, manual);
  db.afterCommit = () => { throw new Error('response lost'); };
  const initial = await service.save(stock.id, request);
  assert.equal(initial.status, 'ok');
  assert.equal(initial.latest?.revision, 1);
  assert.equal(initial.latest?.conditions.manualPlannedUnitPriceYen, '5000');
  const read = await service.read(stock.id);
  assert.equal(read.status, 'ok');
  assert.equal(read.latest?.revision, 1);
  assert.equal(read.source.plannedUnitPriceYen, null);
  assert.equal(read.stale, false);
  assert.equal((await service.save(stock.id, request)).status, 'ok');
  assert.equal((await service.save(stock.id, { ...request, conditions: { ...manual, saleCount: 3 } })).status, 'conflict');
  const next = await makeRequest(service, { ...manual, saleCount: 3 });
  assert.equal((await service.save(stock.id, next)).status, 'conflict', 'an operation ID cannot be repurposed');
  assert.equal((await service.save(stock.id, { ...next, operationId: 'eb0d5bf8-0fd3-4fd9-ab64-3a3cd90483ea' })).status, 'ok');
  assert.equal((await store.getPlan(stock.id))?.plan.revision, 2);
  assert.equal((await service.save(stock.id, request)).status, 'ok', 'non-latest operation replay must remain idempotent');
  assert.deepEqual(db.get('Inventory', stock), before);
  assert.equal(db.writes.length, 2);
  assert.equal([...db.rows.keys()].filter(key => key.includes('quantity-plan')).length, 3);
  const stored = db.get('InventoryAnalysisMetadata', { scope: 'quantity-plan', id: stock.id });
  assert.ok(!String(stored?.valueJson).includes('keep-me'));
  assert.ok(!String(stored?.valueJson).includes('editHistory'));
});

test('stale calculation or transaction versions do not save any plan or audit row', async () => {
  const { db, service } = context();
  const first = await makeRequest(service);
  db.beforeCompare = () => db.set('Inventory', { ...stock, quantity: 7 });
  assert.equal((await service.save(stock.id, first)).status, 'conflict', 'same timestamp and revision still conflict');
  const second = await makeRequest(service);
  db.beforeCompare = () => db.set('Category', { id: stock.categoryId, name: '出品待ち' });
  assert.equal((await service.save(stock.id, second)).status, 'conflict');
  const third = await makeRequest(service);
  db.beforeCompare = () => db.set('InventoryAnalysisMetadata', {
    scope: 'current', id: 'inventory:' + stock.id, revision: 2, valueJson: JSON.stringify(inventoryMeta),
  });
  assert.equal((await service.save(stock.id, third)).status, 'conflict');
  assert.equal(db.writes.length, 0);
  const fourth = await makeRequest(service);
  assert.equal((await service.save(stock.id, fourth)).status, 'ok');
  const fifth = await makeRequest(service, { ...conditions, saleCount: 3 }, 'f6565942-c93a-4989-9aff-ae83d338987a');
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings })).status, 'ok');
  assert.equal((await service.save(stock.id, fifth)).status, 'conflict');
  const changed = await service.read(stock.id);
  assert.equal(changed.status, 'ok');
  assert.equal(changed.stale, true);
  assert.equal(changed.latest?.revision, 1);
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings })).status, 'conflict');
});

test('area standards and future cost setting inputs are bounded and scoped to approved classifications', async () => {
  const { service } = context();
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings, standards: [{ ...standard, categoryId: 'workflow' }],
  } })).status, 'invalid');
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings, expenses: [{ id: 'retail-fee', channel: 'retail', label: '手数料', basis: 'revenue-percent', value: '100.000000000000001' }],
  } })).status, 'invalid');
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings, standards: [standard, standard],
  } })).status, 'invalid');
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings, standards: [{ ...standard, method: 'flat' }],
  } })).status, 'invalid');
  assert.equal((await service.saveSettings({ expectedRevision: 0, expectedTaxonomyRevision: 20, settings })).status, 'conflict');
});

test('large UTF-8 cost definitions remain saveable with both comparison scenarios', async () => {
  const { db, service } = context();
  const repeat = (count: number, label: string) => Array.from({ length: count }, (_, i) =>
    ({ id: 'entry-' + i, label: label.repeat(60), channel: 'retail' as const, basis: 'per-unit' as const }));
  const result = await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings,
    expenses: repeat(40, '費').map(item => ({ ...item, value: 1 })),
    remainingWork: repeat(40, '業').map(item => ({ ...item, minutes: 1 })),
  } });
  assert.equal(result.status, 'ok');
  const request = await makeRequest(service);
  const save = await service.save(stock.id, request);
  assert.equal(save.status, 'ok');
  const row = db.get('InventoryAnalysisMetadata', { scope: 'quantity-plan', id: stock.id });
  const bytes = Buffer.byteLength(String(row?.valueJson));
  assert.ok(bytes > 96 * 1024 && bytes < 320 * 1024, String(bytes));
});

test('remaining work respects workflow and covered fees; disassembly applies per unit and reassembly to retail', async () => {
  const { db, service } = context();
  const disassembled: QuantityAreaStandard = { ...standard, method: 'disassembled', disassemblyMinutes: 10, reassemblyMinutes: 20 };
  assert.equal((await service.saveSettings({ expectedRevision: 0, settings: {
    ...settings, standards: [disassembled],
    expenses: [{ id: 'retail-fee', channel: 'retail', basis: 'once', label: '出品料', value: 1000 }],
    remainingWork: [
      { id: 'photography', channel: 'retail', basis: 'once', label: '撮影', minutes: 30 },
      { id: 'listing', channel: 'retail', basis: 'once', label: '出品', minutes: 20, includedInExpenseId: 'retail-fee' },
      { id: 'packing', channel: 'retail', basis: 'per-unit', label: '梱包', minutes: 10 },
    ],
  } })).status, 'ok');
  const input = { ...conditions, storageMethod: 'disassembled' as const };
  const pending = await service.calculate(stock.id, input);
  assert.equal(pending.status, 'ok');
  assert.ok(pending.calculation.ok);
  const work = pending.calculation.plan.inputs.remainingWork;
  assert.equal(work.find(item => item.id === 'photography')?.minutes, 30);
  assert.equal(work.some(item => item.id === 'listing'), false);
  assert.equal(work.find(item => item.id === 'packing')?.minutes, null);
  assert.equal(work.find(item => item.id === 'disassembly-wholesale')?.minutes, 10);
  assert.equal(work.find(item => item.id === 'reassembly')?.channel, 'retail');
  assert.equal(work.find(item => item.id === 'reassembly')?.minutes, 20);
  db.set('Category', { id: stock.categoryId, name: '販売中' });
  const listed = await service.calculate(stock.id, input);
  assert.equal(listed.status, 'ok');
  assert.ok(listed.calculation.ok);
  assert.equal(listed.calculation.plan.inputs.remainingWork.some(item => item.id === 'photography'), false);
  db.set('InventoryAnalysisMetadata', {
    scope: 'current', id: 'inventory:' + stock.id, revision: 2, valueJson: JSON.stringify({
      ...inventoryMeta, categoryState: 'candidate',
    }),
  });
  const unclassified = await service.calculate(stock.id, input);
  assert.equal(unclassified.status, 'ok');
  assert.ok(!unclassified.calculation.ok);
  assert.ok(unclassified.calculation.issues.some(item => item.field === 'area' && item.reason === 'missing'));
});

test('staging policy grants the quantity scopes and current CAS without adding a new table or scan', () => {
  const backend = readFileSync(new URL('../../../amplify/backend.ts', import.meta.url), 'utf8');
  const start = backend.indexOf("'AnalysisRuntime'");
  const end = backend.indexOf('inventoryTable.grantReadData', start);
  const policy = backend.slice(start, end);
  assert.match(policy, /BelloAmplifyStagingComputeRole/);
  assert.match(policy, /\['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem'\][\s\S]+?\['quantity-plan', 'quantity-settings'\]/);
  assert.match(policy, /\['dynamodb:ConditionCheckItem'\], resources: \[inventoryAnalysisMetadataTable.tableArn\][\s\S]+?\['current'\]/);
  assert.doesNotMatch(policy, /dynamodb:Scan|dynamodb:DeleteItem/);
});
