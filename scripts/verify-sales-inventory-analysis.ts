import assert from 'node:assert/strict';
import { buildAnalysis } from '../lib/inventory/analysis/aggregate';
import {
  analysisFixtureAsOf as asOf, analysisFixtureGeneration as generation, analysisFixtureTaxonomy as taxonomy, analysisFixtureWorkflow as workflow,
  createAnalysisAcquisitionReturnFixture, createAnalysisFixture, fixtureAssignment, fixtureInventory, fixtureKind, fixtureLot,
} from '../lib/inventory/analysis/fixtures';
import { sourceKey } from '../lib/inventory/analysis/normalize';
import { normalizedCapturedSalesRecords } from '../lib/inventory/analysis/salesProjection';
import { buildMonthlyAggregates } from '../lib/inventory/salesAggregate';
import { rollingPeriod, sourceDay } from '../lib/inventory/analysis/period';
import { drilldownAnalysis, queryAnalysis } from '../lib/inventory/analysis/query';
import { UNKNOWN, type AnalysisBuild, type AnalysisRequest, type AnalysisSource, type Dimension, type MetadataRow, type Target } from '../lib/inventory/analysis/types';
import { buildInventoryValue } from '../lib/inventory/inventoryValue';
import { summarizeSales } from '../lib/inventory/sales';

const build = (rows: AnalysisSource[], metadata: MetadataRow[] = []) => buildAnalysis(rows, workflow, [taxonomy, ...metadata], asOf, generation);
const assignment = (row: string, kind: string | null, lot: string) =>
  fixtureAssignment(row, kind, { lotId: sourceKey('fixture-supplier', lot), lotState: 'confirmed' });
const split = (sourceInventoryId: string, mutationId: string, operation = 'STOCK_SPLIT') =>
  ({ __belloStockSplit: { sourceInventoryId, mutationId, operation } });
const take = (model: AnalysisBuild, target: Target, dates: Partial<AnalysisRequest> = {}) => {
  const result = queryAnalysis(model, { target, ...dates });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('Missing test analysis');
  return result;
};
const bucket = (model: AnalysisBuild, target: Target, dimension: Dimension, key: string) =>
  take(model, target).summary.dimensions[dimension]?.find(value => value.key === key);
function verifiesSums(model: AnalysisBuild, target: Target) {
  const { summary } = take(model, target);
  for (const [dimension, buckets] of Object.entries(summary.dimensions)) {
    for (const metric of ['amount', 'gross', 'returns', 'quantity', 'grossQuantity', 'returnedQuantity', 'records'] as const) {
      assert.equal(buckets.reduce((total, value) => total + value[metric], 0), summary[metric], dimension + ': ' + metric);
    }
    if (dimension === 'holding' || dimension === 'holdingBand' || dimension === 'holdingCount' || dimension === 'category') {
      assert.equal(buckets.reduce((total, value) => total + value.kinds, 0), summary.kinds, dimension);
    }
  }
}

// Fixed example 1: 8 x ¥10,000 plus 1 x ¥20,000.
const fixture = createAnalysisFixture();
const current = take(fixture, 'inventory').summary;
assert.deepEqual([current.amount, current.quantity, current.kinds], [100000, 9, 2]);
const multiple = bucket(fixture, 'inventory', 'holding', 'multiple')!;
assert.deepEqual([multiple.amount / current.amount, multiple.quantity / current.quantity, multiple.kinds / current.kinds], [0.8, 8 / 9, 0.5]);
assert.equal(bucket(fixture, 'inventory', 'category', 'chairs')?.color, bucket(fixture, 'sales', 'category', 'chairs')?.color);
assert.equal(bucket(fixture, 'acquisitions', 'category', 'chairs')?.color, bucket(fixture, 'retailReference', 'category', 'chairs')?.color);
assert.equal(take(fixture, 'retailReference').summary.amount, 70000);
for (const target of ['inventory', 'sales', 'acquisitions', 'retailReference'] as const) verifiesSums(fixture, target);

// Fixed example 2: the last current item is single, the sale came from an 8-item lot.
const remaining = build([
  fixtureInventory('remaining', 1, 10000),
  fixtureInventory('sold7', 0, 10000, { categoryId: 'sold', saleEndDate: '2026-11-10', salePrice: 70000,
    customFields: { ...split('remaining', 'sale-01', 'SOLD_OUT'), __belloSale: { physicalQuantity: 7 } } }),
], [fixtureKind('chairs'), fixtureLot('original-8', '2026-11-05', 8, 80000), assignment('remaining', 'chairs', 'original-8')]);
assert.equal(bucket(remaining, 'inventory', 'holding', 'single')?.quantity, 1);
assert.equal(bucket(remaining, 'sales', 'lot', 'multiple')?.amount, 70000);
assert.equal(bucket(remaining, 'sales', 'lotBand', '4-8')?.quantity, 7);

// Fixed example 3: same-kind singles remain two acquisition lots.
const twoSingles = build([fixtureInventory('yesterday', 1, 5000), fixtureInventory('today', 1, 5000)], [
  fixtureKind('chairs'), fixtureLot('single-yesterday', '2026-11-13', 1, 5000), fixtureLot('single-today', '2026-11-14', 1, 5000),
  assignment('yesterday', 'chairs', 'single-yesterday'), assignment('today', 'chairs', 'single-today'),
]);
assert.deepEqual([bucket(twoSingles, 'inventory', 'holding', 'multiple')?.quantity, bucket(twoSingles, 'inventory', 'holding', 'multiple')?.kinds], [2, 1]);
assert.equal(bucket(twoSingles, 'acquisitions', 'lot', 'single')?.lots, 2);

const exactHoldings = buildAnalysis([
  fixtureInventory('one', 1, 100), fixtureInventory('two-a', 1, 200),
  fixtureInventory('two-b', 1, 300, { categoryId: 'photo' }), fixtureInventory('three', 3, 400),
  fixtureInventory('five-a', 2, 500), fixtureInventory('five-b', 3, 600, { categoryId: 'trade' }),
  fixtureInventory('ten', 10, 100), fixtureInventory('unknown-kind', 2, null, { name: 'five-a' }),
  fixtureInventory('same-title-unmatched', 2, 55, { name: 'five-a' }),
  fixtureInventory('zero-current', 0, 100), fixtureInventory('missing-current', null, 100),
  fixtureInventory('previously-sold', 4, 100, { categoryId: 'sold', saleEndDate: '2026-11-10' }),
], [...workflow, { id: 'photo', name: '撮影待ち' }], [
  taxonomy,
  ...['one', 'two', 'three', 'five', 'ten'].map(kind => fixtureKind(kind, null)),
  ...['one', 'three', 'ten'].map(kind => fixtureAssignment(kind, kind)),
  fixtureAssignment('two-a', 'two'), fixtureAssignment('two-b', 'two'),
  assignment('five-a', 'five', 'lot2'), assignment('five-b', 'five', 'lot3'),
  fixtureLot('lot2', '2026-11-13', 2, 1000), fixtureLot('lot3', '2026-11-13', 3, 1800),
  fixtureAssignment('zero-current', 'five'), fixtureAssignment('missing-current', 'five'), fixtureAssignment('previously-sold', 'five'),
], asOf, generation);
const exact = take(exactHoldings, 'inventory').summary;
assert.deepEqual(exact.dimensions.holdingCount?.map(({ key, label, amount, quantity, kinds, records }) => [key, label, amount, quantity, kinds, records]), [
  ['1', '1点保有', 100, 1, 1, 1], ['2', '2点保有', 610, 6, 1, 4], ['3', '3点保有', 1200, 3, 1, 1],
  ['5', '5点保有', 2800, 5, 1, 2], ['10', '10点保有', 1000, 10, 1, 1],
]);
assert.equal(exact.amount, exactHoldings.inventoryValue.total);
assert.equal(exact.quantity, exactHoldings.inventoryValue.quantity);
assert.equal(exact.records, exactHoldings.inventoryValue.count);
verifiesSums(exactHoldings, 'inventory');
const exactRequest = { target: 'inventory', generation, dimension: 'holdingCount', key: '5' } as const;
const exactDetail = drilldownAnalysis(exactHoldings, exactRequest);
assert(exactDetail.status === 'ok');
assert.deepEqual(exactDetail.items.map(item => item.type === 'group' && [item.group.kindId, item.group.count, item.group.representative.holdingCount, item.group.representative.holdingBasis]), [['five', 2, 5, 'confirmed-kind']]);
const exactMembers = drilldownAnalysis(exactHoldings, { ...exactRequest, groupKindId: 'five' });
assert(exactMembers.status === 'ok');
assert.deepEqual(exactMembers.items.map(item => item.type === 'record' && [item.record.id, item.record.quantity]), [['five-a', 2], ['five-b', 3]]);
const twoDetail = drilldownAnalysis(exactHoldings, { ...exactRequest, key: '2' });
assert(twoDetail.status === 'ok');
assert.deepEqual(twoDetail.items.flatMap(item => item.type === 'record' ? [[item.record.id, item.record.holdingCount, item.record.holdingBasis, item.record.kindId, item.record.kindCount]] : []), [
  ['same-title-unmatched', 2, 'inventory-record', null, 0], ['unknown-kind', 2, 'inventory-record', null, 0],
]);
assert.equal(exact.unknown.kind, 2);
assert.equal(exact.kinds, 5);
assert.equal(drilldownAnalysis(exactHoldings, { ...exactRequest, generation: 'different-generation' }).status, 'expired');
for (const key of ['0', '02', '2-3', '2.0', '9007199254740992']) {
  assert.equal(drilldownAnalysis(exactHoldings, { ...exactRequest, key }).status, 'error');
}
const olderExactHoldings = { ...exactHoldings, inventory: exactHoldings.inventory.map(({ holdingCount: _count, holdingBasis: _basis, ...fact }) => fact) };
assert.deepEqual(take(olderExactHoldings, 'inventory').summary.dimensions.holdingCount, exact.dimensions.holdingCount);
assert.deepEqual(drilldownAnalysis(olderExactHoldings, exactRequest), exactDetail);
const missingCount = { ...olderExactHoldings, inventory: olderExactHoldings.inventory.map(fact => fact.id === 'unknown-kind'
  ? { ...fact, quantity: null, unknown: { ...fact.unknown, quantity: 1 } } : fact) };
assert.equal(bucket(missingCount, 'inventory', 'holdingCount', UNKNOWN)?.unknown.quantity, 1);
const unknownDetail = drilldownAnalysis(missingCount, { ...exactRequest, key: UNKNOWN });
assert(unknownDetail.status === 'ok');
assert.deepEqual(unknownDetail.items.map(item => item.type === 'record' && [item.record.id, item.record.holdingCount, item.record.holdingBasis]), [['unknown-kind', null, 'unknown']]);

// Fixed example 4: 20 acquired, 12 remain, 8 sold wholesale. Warehouse image is source-specific.
const twenty = build([
  fixtureInventory('original', 12, 10000, { name: '正式商品名 20脚', images: [
    { storageKey: 'inventory/damage.jpg', sortOrder: 0, type: 'DAMAGE', isPrimary: true },
    { storageKey: 'inventory/main.jpg', thumbnailKey: 'inventory/main.thumb.jpg', sortOrder: 1, isPrimary: true },
  ] }),
  fixtureInventory('wholesale', 0, 10000, {
    categoryIds: ['trade', 'sold'], saleEndDate: '2026-11-13', salePrice: 90000, market: 'リステージ業者間',
    customFields: { ...split('original', 'sale-02', 'SOLD_OUT'), __belloSale: { physicalQuantity: 8 } },
  }),
], [fixtureKind('chairs'), fixtureLot('line20', '2026-11-01', 20, 200000), assignment('original', 'chairs', 'line20'),
  fixtureAssignment('wholesale', 'chairs', { retail: 'confirmed', saleCostTotal: 80000, saleCostEvidence: { source: 'invoice', recordId: 'trade' } }),
]);
const acquired = take(twenty, 'acquisitions').summary;
assert.deepEqual([acquired.amount, acquired.quantity, acquired.lots], [200000, 20, 1]);
assert.deepEqual([take(twenty, 'inventory').summary.amount, take(twenty, 'inventory').summary.quantity], [120000, 12]);
assert.equal(take(twenty, 'sales').summary.amount, 90000);
assert.equal(take(twenty, 'retailReference').summary.records, 0);
assert.equal(twenty.referenceExclusions.excluded, 1);
assert.equal(twenty.acquisitions[0].title, '正式商品名 20脚');
assert.equal(twenty.acquisitions[0].imageRef, 'inventory/main.thumb.jpg');
assert.equal(twenty.acquisitions[0].inventoryId, 'original');

// Fixed example 5: 8-piece set for ¥100,000, unknown sale quantity stays unknown.
const setSale = build([
  fixtureInventory('set8', 0, 10000, { saleEndDate: '2026-11-01', categoryId: 'sold', salePrice: 100000, customFields: { __belloSale: { physicalQuantity: 8 } } }),
  fixtureInventory('qty0', 0, 0, { saleEndDate: '2026-11-01', categoryId: 'sold', salePrice: 0 }),
  fixtureInventory('qty1', 1, 1000, { saleEndDate: '2026-11-01', categoryId: 'sold', salePrice: 0 }),
]);
assert.deepEqual([take(setSale, 'sales').summary.amount, take(setSale, 'sales').summary.quantity, take(setSale, 'sales').summary.unknown.quantity], [100000, 8, 2]);
assert.equal(setSale.sales.find(fact => fact.id === 'qty0')?.quantity, null);

// Fixed example 6: confirmed spec separates colors/sizes; operational title changes do not.
const differentSpecs = build([
  fixtureInventory('small', 1, 1000, { name: 'M1' }),
  fixtureInventory('large', 1, 1000, { name: 'M1' }),
  fixtureInventory('white', 1, 1000, { name: 'M1' }),
  fixtureInventory('same-small', 1, 1000, { name: '【出荷予定】M1' }),
  fixtureInventory('unconfirmed', 1, null, { name: '【出荷予定】M1' }),
], [
  fixtureKind('black-small', 'chairs', '黒', 'S'), fixtureKind('black-large', 'chairs', '黒', 'L'), fixtureKind('white-small', 'chairs', '白', 'S'),
  fixtureAssignment('small', 'black-small'), fixtureAssignment('same-small', 'black-small', { categoryId: 'tables', categoryState: 'confirmed' }),
  fixtureAssignment('large', 'black-large'), fixtureAssignment('white', 'white-small'),
  fixtureAssignment('unconfirmed', 'black-small', { kindState: 'candidate' }),
]);
assert.equal(take(differentSpecs, 'inventory').summary.kinds, 3);
assert.equal(bucket(differentSpecs, 'inventory', 'holding', 'multiple')?.records, 2);
assert.equal(bucket(differentSpecs, 'inventory', 'category', 'tables'), undefined);
assert.equal(bucket(differentSpecs, 'inventory', 'category', UNKNOWN)?.unknown.kind, 1);
verifiesSums(differentSpecs, 'inventory');

const incomplete = build([fixtureInventory('unpriced', 3, null), fixtureInventory('zero', 2, 0)], [fixtureKind('chair'), fixtureAssignment('unpriced', 'chair')]);
assert.deepEqual(incomplete.inventory.map(fact => fact.amount), [null, 0]);
assert.equal(take(incomplete, 'inventory').summary.unknown.cost, 1);
assert.equal(take(incomplete, 'inventory').summary.kinds, 1);
assert.equal(take(incomplete, 'inventory').summary.quantity, 5);
assert.equal(bucket(incomplete, 'inventory', 'category', UNKNOWN)?.quantity, 2);

const imported = build([
  ...['1', '2'].map((goodsId) => fixtureInventory('re-' + goodsId, 0, 1, {
    transactionDate: '2026-11-01',
    customFields: { __restageImport: { goodsId, date: '2026-11-01', quantity: 2, hammerPrice: 1000, isBundle: true, ledger: { purchaseTotal: 99999, quantity: 999 } } },
  })),
  ...['a', 'b'].map((auctionId) => fixtureInventory('ya-' + auctionId, 0, 1, {
    customFields: { __yahooPurchaseImport: { auctionId, date: '2026-11-01', quantity: 3, itemTotal: 2000, shipping: 200 } },
  })),
  ...['business', 'personal'].map((account) => fixtureInventory('tf-' + account, 0, 1, {
    customFields: { __trefacImport: { account, goodsId: '11', date: '2026-11-01', quantity: 2, purchaseTotal: 3000 } },
  })),
]);
assert.deepEqual([take(imported, 'acquisitions').summary.lots, take(imported, 'acquisitions').summary.quantity, take(imported, 'acquisitions').summary.amount], [6, 14, 12776]);

const damagedLineage = build([
  fixtureInventory('A', 0, 100, { customFields: split('B', '1'), saleEndDate: '2026-11-02', salePrice: 3000 }),
  fixtureInventory('B', 0, 100, { customFields: split('A', '2') }),
  fixtureInventory('C', 0, 100, { sourceInventoryId: 'root', customFields: split('missing', '3') }),
  fixtureInventory('D', 0, 100, { customFields: split('root', 'repeated') }),
  fixtureInventory('E', 0, 100, { customFields: split('root', 'repeated') }),
  fixtureInventory('root', 1, 100),
], [fixtureLot('known', '2026-11-01', 10, 1000), assignment('root', null, 'known'), assignment('A', null, 'known'), assignment('C', null, 'known'), assignment('D', null, 'known')]);
assert.equal(damagedLineage.sales[0].lotId, null);
assert.equal(damagedLineage.metadata.unlocatedAcquisitionRecords, 5);
assert.equal(take(damagedLineage, 'acquisitions').summary.lots, 1);
assert.throws(() => build([fixtureInventory('duplicate', 1, 100), fixtureInventory('duplicate', 1, 100)]));
assert.throws(() => build([], [{ id: 'invalid-lot', revision: 1, value: { ...fixtureLot('line', '2026-11-01', 1, 100).value, id: 'unscoped' } as MetadataRow['value'] }]));

const boundaries = build([
  fixtureInventory('before', 1, 1, { salePrice: 15, saleEndDate: '2026-11-13T14:59:59.999Z' }),
  fixtureInventory('included', 1, 1, { salePrice: 5, saleEndDate: '2026-11-13T15:00:00.000Z' }),
  fixtureInventory('exact', 1, 1, { salePrice: -10, saleEndDate: asOf }),
  fixtureInventory('future-same-day', 1, 1, { salePrice: 80, saleEndDate: '2026-11-14T03:00:00.001Z' }),
  fixtureInventory('future-day', 1, 1, { salePrice: 90, saleEndDate: '2026-11-15' }),
  fixtureInventory('undated', 0, 1, { salePrice: 1000, categoryId: 'sold' }),
], [
  fixtureLot('prev', '2026-10-15T14:59:59Z', 1, 100),
  fixtureLot('first', '2026-10-15T15:00:00Z', 1, 200),
  fixtureLot('future', '2026-11-14T03:00:00.001Z', 1, 300),
  fixtureLot('returned', '2026-11-14', 1, 250, { operation: 'return', originalLotId: sourceKey('fixture-supplier', 'first') }),
]);
assert.equal(rollingPeriod(asOf, 30).start, '2026-10-16');
assert.equal(rollingPeriod(asOf, 90).start, '2026-08-17');
assert.equal(sourceDay('2026-02-30', asOf), null);
assert.equal(sourceDay('2026-11-14T12:00:00+09:00', asOf), '2026-11-14');
assert.equal(sourceDay('2026-11-14T12:00:00.001+09:00', asOf), null);
const day = take(boundaries, 'sales', { start: '2026-11-14', end: '2026-11-14' });
assert.deepEqual([day.summary.amount, day.summary.gross, day.summary.returns, day.summary.records], [-5, 5, 10, 2]);
assert.equal(day.period?.partial, true);
assert.equal(boundaries.metadata.unlocatedSalesRecords, 1);
const netAcquisition = take(boundaries, 'acquisitions').summary;
assert.deepEqual([netAcquisition.amount, netAcquisition.gross, netAcquisition.returns, netAcquisition.quantity, netAcquisition.lots], [-50, 200, 250, 0, 1]);
assert.equal(take(build([]), 'sales').summary.records, 0);
assert.equal(queryAnalysis(boundaries, { target: 'sales', start: '2026-12-01', end: '2026-12-31' }).status, 'missing');
assert.equal(queryAnalysis(boundaries, { target: 'inventory', daily: '2026-11-13' }).status, 'missing');
assert.equal(queryAnalysis(boundaries, { target: 'inventory', generation: 'other' }).status, 'expired');
assert.equal(queryAnalysis(boundaries, { target: 'sales', start: 'invalid', end: '2026-11-30' }).status, 'error');
assert.equal(queryAnalysis({ ...boundaries, metadata: { ...boundaries.metadata, coverageStart: '2026-11-10' } }, { target: 'sales' }).status, 'missing');

const oldLotReturn = createAnalysisAcquisitionReturnFixture();
const oldLotSummary = take(oldLotReturn, 'acquisitions').summary;
assert.deepEqual([oldLotSummary.quantity, oldLotSummary.grossQuantity, oldLotSummary.returnedQuantity], [-3, 5, 8]);
assert.deepEqual([oldLotSummary.amount, oldLotSummary.gross, oldLotSummary.returns], [-30000, 50000, 80000]);
assert.deepEqual([oldLotSummary.records, oldLotSummary.lots], [2, 1]);
const chartQuantities = oldLotSummary.dimensions.category!.map(({ key, quantity, grossQuantity, returnedQuantity }) =>
  [key, quantity, grossQuantity, returnedQuantity]);
assert.deepEqual(chartQuantities, [['chairs', 5, 5, 0], ['tables', -8, 0, 8]]);
verifiesSums(oldLotReturn, 'acquisitions');

const legacyRows = [
  fixtureInventory('active', 2, 1000), fixtureInventory('trade', 3, 2000, { categoryIds: ['trade', 'active'] }),
  fixtureInventory('missingPrice', 1, null), fixtureInventory('deleted', 100, 10, { deletedAt: '2026-11-01' }),
  fixtureInventory('inconsistent', 2, 5000, { saleEndDate: '2026-11-02', salePrice: 1000 }),
  fixtureInventory('soldNegative', 0, 100, { categoryId: 'sold', saleEndDate: '2026-11-09', salePrice: -3000 }),
  fixtureInventory('invalidQuantity', -1, 100),
  fixtureInventory('unknownWorkflow', 2, 100, { categoryId: 'unregistered' }),
];
const compatible = build(legacyRows);
const legacyStock = buildInventoryValue(legacyRows, workflow, asOf);
const legacySales = summarizeSales(legacyRows.filter(row => !row.deletedAt).map(row => ({
  id: row.id, displayId: row.id, sku: '', name: row.name ?? '', saleEndDate: row.saleEndDate ?? null,
  salePrice: row.salePrice ?? null, purchasePrice: row.purchasePrice ?? null, shippingCost: null,
})), 2026, 11);
assert.deepEqual(compatible.inventoryValue, legacyStock);
assert.deepEqual([take(compatible, 'inventory').summary.amount, take(compatible, 'inventory').summary.quantity], [legacyStock.total, legacyStock.quantity]);
assert.equal(take(compatible, 'sales').summary.amount, legacySales.totalSales);
verifiesSums(compatible, 'inventory');
verifiesSums(compatible, 'sales');

const request = { target: 'inventory' as const, generation, limit: 1 };
const first = drilldownAnalysis(fixture, request);
assert.equal(first.status, 'ok');
if (first.status !== 'ok' || !first.nextCursor) throw new Error('Expected a second page');
assert.deepEqual(first.items.map(item => item.type === 'group' && [item.group.kindId, item.group.count, item.group.amount]), [['chair', 2, 80000]]);
assert.equal(drilldownAnalysis(fixture, { ...request, cursor: first.nextCursor, dimension: 'category', key: 'chairs' }).status, 'error');
assert.equal(drilldownAnalysis(fixture, { ...request, cursor: first.nextCursor, generation: 'previous' }).status, 'expired');
const second = drilldownAnalysis(fixture, { ...request, cursor: first.nextCursor });
assert.equal(second.status, 'ok');
if (second.status !== 'ok') throw new Error('Expected second page');
assert.equal(second.nextCursor, null);
assert.deepEqual(second.items.map(item => item.type === 'group' && item.group.kindId), ['table']);
const children = drilldownAnalysis(fixture, { ...request, dimension: 'category', key: 'chairs', groupKindId: 'chair', limit: 100 });
assert.equal(children.status, 'ok');
if (children.status !== 'ok') throw new Error('Expected group children');
assert.deepEqual(children.items.map(item => item.type === 'record' && item.record.inventoryId), ['chair-a', 'chair-b']);
const rollingSales = queryAnalysis(fixture, {target:'sales',rollingDays:30,generation});
assert.equal(rollingSales.status,'ok');
if(rollingSales.status !== 'ok') throw new Error('Rolling sales must use the captured JST day');
assert.deepEqual(rollingSales.period,rollingPeriod(asOf,30));
assert.equal(queryAnalysis(fixture,{target:'sales',rollingDays:30,start:'2026-11-01',end:'2026-11-14'}).status,'error');
assert.equal(queryAnalysis(fixture,{target:'inventory',rollingDays:30}).status,'error');
assert.equal(queryAnalysis(fixture,{target:'sales',rollingDays:30,generation:'other'}).status,'expired');

const jstMonthCutoff = '2026-10-31T16:00:00.000Z';
const monthBoundaryRows = [
  fixtureInventory('oct-last', 0, 100, { saleEndDate: '2026-10-31T14:59:59.999Z', salePrice: 3 }),
  fixtureInventory('nov-first', 0, 100, { saleEndDate: '2026-10-31T15:00:00.000Z', salePrice: 100000 }),
  fixtureInventory('nov-free', 0, 100, { saleEndDate: jstMonthCutoff, salePrice: 0 }),
  fixtureInventory('nov-missing', 0, 100, { saleEndDate: '2026-11-01', salePrice: null }),
  fixtureInventory('nov-future-time', 0, 100, { saleEndDate: '2026-10-31T16:00:00.001Z', salePrice: 9999 }),
  fixtureInventory('nov-future-date', 0, 100, { saleEndDate: '2026-11-02', salePrice: 9999 }),
  fixtureInventory('bad-date', 0, 100, { saleEndDate: '2026-11-31', salePrice: 9999 }),
  fixtureInventory('deleted', 0, 100, { saleEndDate: '2026-11-01', salePrice: 9999, deletedAt: '2026-11-01' }),
];
const boundaryGeneration = buildAnalysis(monthBoundaryRows, workflow, [taxonomy], jstMonthCutoff, generation);
const monthSummary = take(boundaryGeneration, 'sales').summary;
const boundaryLegacy = buildMonthlyAggregates(normalizedCapturedSalesRecords(monthBoundaryRows, jstMonthCutoff));
assert.deepEqual(boundaryLegacy.map(month => [month.yearMonth, month.count, month.totalSales]), [['2026-10', 1, 3], ['2026-11', 3, 100000]]);
assert.deepEqual([monthSummary.records, monthSummary.amount, monthSummary.unknown.amount, monthSummary.unknown.cost], [3, 100000, 1, 3]);
assert.deepEqual(boundaryGeneration.sales.filter(fact => fact.date === '2026-11-01').map(fact => fact.unknown.amount), [0, 0, 1]);
assert.equal(take(incomplete, 'inventory').summary.unknown.amount, 1);
assert.equal(take(fixture, 'retailReference').summary.unknown.amount, 0);

const privateAccount = 'fixture-private-trefac-login@example.test';
const privateImport = build([
  fixtureInventory('opaque-inventory-01', 1, 3000, {
    salePrice: 5000, saleEndDate: '2026-11-04',
    customFields: { __trefacImport: { account: privateAccount, goodsId: '200', date: '2026-11-01', quantity: 1, purchaseTotal: 3000 } },
  }),
]);
const acquiredDetails = drilldownAnalysis(privateImport, { generation, target: 'acquisitions' });
const saleDetails = drilldownAnalysis(privateImport, { generation, target: 'sales' });
assert.equal(acquiredDetails.status, 'ok');
assert.equal(saleDetails.status, 'ok');
if (acquiredDetails.status !== 'ok' || saleDetails.status !== 'ok') throw new Error('Expected source-linked drilldowns');
const acquiredItem = acquiredDetails.items[0];
const saleItem = saleDetails.items[0];
assert.equal(acquiredItem.type, 'record');
assert.equal(saleItem.type, 'record');
if (acquiredItem.type !== 'record' || saleItem.type !== 'record') throw new Error('Expected individual records');
assert.match(acquiredItem.record.id, /^[0-9a-f]{64}$/);
assert.equal(acquiredItem.record.id, saleItem.record.lotId);
assert.equal(acquiredItem.record.id, acquiredItem.record.lotId);
assert.equal(saleItem.record.inventoryId, 'opaque-inventory-01');
assert.notEqual(acquiredItem.record.id, privateImport.acquisitions[0].id);
assert.equal(JSON.stringify([acquiredDetails, saleDetails]).includes('fixture-private-trefac-login'), false);
console.log('Sales and inventory analysis verified: fixed examples, reconciliation, coverage, lineage, snapshot-anchored rolling periods, and generation drilldown.');

