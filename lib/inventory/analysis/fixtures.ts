import { buildAnalysis } from './aggregate';
import { sourceKey } from './normalize';
import type { AcquisitionLot, AnalysisBuild, AnalysisSource, InventoryMetadata, MetadataRow, ProductKind } from './types';

export const analysisFixtureAsOf = '2026-11-14T03:00:00.000Z';
export const analysisFixtureGeneration = 'fixture-analysis-20261114';
export const analysisFixtureWorkflow = [{ id: 'active', name: '販売中' }, { id: 'sold', name: '売り切れ' }, { id: 'trade', name: '業者間' }];
export const analysisFixtureTaxonomy: MetadataRow = {
  id: 'taxonomy', revision: 1, value: { type: 'taxonomy', categories: [
    { id: 'chairs', label: 'ダイニングチェア' }, { id: 'tables', label: 'テーブル・デスク' },
  ] },
};

export function fixtureKind(id: string, categoryId: string | null = 'chairs', color = '黒', size = 'M'): MetadataRow {
  const value: ProductKind = {
    type: 'kind', id, state: 'confirmed', categoryId, modelId: 'fixture-model',
    specification: { brand: 'サンプル家具', model: 'M1', color, material: '木', size, saleUnit: '点' },
  };
  return { id: 'kind-' + id, revision: 1, value };
}

export function fixtureLot(line: string, date: string, quantity: number, costTotal: number, changes: Partial<AcquisitionLot> = {}): MetadataRow {
  const source = 'fixture-supplier';
  const id = sourceKey(source, line);
  const value: AcquisitionLot = {
    type: 'lot', id, source, sourceRecordId: line, state: 'confirmed', date, quantity, costTotal, categoryId: 'chairs',
    kindId: null, merchandise: true, operation: 'acquisition', originalLotId: null, ...changes,
  };
  return { id: 'lot-' + id, revision: 1, value };
}

export function fixtureAssignment(inventoryId: string, kindId: string | null, changes: Partial<InventoryMetadata> = {}): MetadataRow {
  const value: InventoryMetadata = {
    type: 'inventory', inventoryId, categoryId: null, categoryState: 'unknown', kindId,
    kindState: kindId ? 'confirmed' : 'unknown', lotId: null, lotState: 'unknown', retail: 'unknown',
    salesQuantity: null, salesQuantityEvidence: null, saleCostTotal: null, saleCostEvidence: null, ...changes,
  };
  return { id: 'inventory-' + inventoryId, revision: 1, value };
}

export function fixtureInventory(id: string, quantity: number | null, purchasePrice: number | null, changes: Partial<AnalysisSource> = {}): AnalysisSource {
  return { id, name: id, categoryId: 'active', quantity, purchasePrice, ...changes };
}

export function createAnalysisFixture(): AnalysisBuild {
  const { value } = fixtureLot('chair-01', '2026-11-08', 15, 150000);
  if (value.type !== 'lot') throw new Error('INVALID_FIXTURE');
  const rows = [
    fixtureInventory('chair-a', 5, 10000, { name: 'サンプル家具 M1 ダイニングチェア' }),
    fixtureInventory('chair-b', 3, 10000, { name: '【撮影済】サンプル家具 M1 ダイニングチェア' }),
    fixtureInventory('table-a', 1, 20000, { name: 'サンプル家具 テーブル' }),
    fixtureInventory('set-sale', 0, 10000, {
      name: 'サンプル家具 ダイニングチェア 7脚セット', categoryId: 'sold', salePrice: 100000, saleEndDate: '2026-11-10',
      customFields: { __belloSale: { physicalQuantity: 7 } },
    }),
    fixtureInventory('uncategorized-sale', 0, null, { name: 'サンプル商品', categoryId: 'sold', salePrice: 25000, saleEndDate: '2026-11-09' }),
    fixtureInventory('sale-return', 0, null, { name: 'サンプル商品 返品', categoryId: 'sold', salePrice: -10000, saleEndDate: '2026-11-10' }),
  ];
  const lot = { lotId: value.id, lotState: 'confirmed' as const };
  const metadata = [
    analysisFixtureTaxonomy, fixtureKind('chair'), fixtureKind('table', 'tables'),
    { id: 'lot-' + value.id, revision: 1, value },
    fixtureAssignment('chair-a', 'chair', lot), fixtureAssignment('chair-b', 'chair', lot), fixtureAssignment('table-a', 'table'),
    fixtureAssignment('set-sale', 'chair', { ...lot, retail: 'confirmed', saleCostTotal: 70000, saleCostEvidence: { source: 'fixture-order', recordId: 'sale-01' } }),
  ];
  return buildAnalysis(rows, analysisFixtureWorkflow, metadata, analysisFixtureAsOf, analysisFixtureGeneration);
}

/** A return booked this month for stock bought before the acquisition window. */
export function createAnalysisAcquisitionReturnFixture(): AnalysisBuild {
  const oldLot = fixtureLot('old-table', '2026-09-12', 8, 80000, { categoryId: 'tables' });
  return buildAnalysis([], analysisFixtureWorkflow, [
    analysisFixtureTaxonomy,
    oldLot,
    fixtureLot('new-chair', '2026-11-10', 5, 50000),
    fixtureLot('returned-table', '2026-11-11', 8, 80000, {
      categoryId: 'tables', operation: 'return', originalLotId: sourceKey('fixture-supplier', 'old-table'),
    }),
  ], analysisFixtureAsOf, analysisFixtureGeneration);
}
