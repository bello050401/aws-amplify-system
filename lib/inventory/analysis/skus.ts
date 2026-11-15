import { positive } from './normalize';
import { UNKNOWN, type Dimension, type Fact, type SkuDimension } from './types';

export function inventorySku(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function isSkuGroupKey(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

export function isSkuDimension(dimension: Dimension | undefined): dimension is SkuDimension {
  return dimension === 'skuCategory' || dimension === 'skuHoldingCount';
}

export interface CurrentSku {
  sku: string;
  records: Fact[];
  category: string;
  holdingCount: number | null;
}

export function currentSkus(facts: readonly Fact[]) {
  const bySku = new Map<string, Fact[]>();
  let unknownSkuRecords = 0;
  for (const fact of facts) {
    const sku = inventorySku(fact.sku);
    if (sku === null) {
      unknownSkuRecords++;
      continue;
    }
    const records = bySku.get(sku) ?? [];
    records.push(fact);
    bySku.set(sku, records);
  }
  const groups: CurrentSku[] = [];
  for (const [sku, records] of bySku) {
    const categories = new Set(records.map(record => record.category).filter(category => category !== UNKNOWN));
    const category = categories.size === 1 ? categories.values().next().value ?? UNKNOWN : UNKNOWN;
    let quantity = 0;
    let missingQuantity = false;
    for (const record of records) {
      const value = positive(record.quantity);
      if (value === null) missingQuantity = true;
      else quantity += value;
    }
    if (!Number.isSafeInteger(quantity)) throw new Error('ANALYSIS_QUANTITY_OVERFLOW');
    groups.push({ sku, records, category, holdingCount: missingQuantity ? null : quantity });
  }
  return { groups, unknownSkuRecords };
}

export function skuDimensionKey(group: CurrentSku, dimension: SkuDimension): string {
  if (dimension === 'skuCategory') return group.category;
  return group.holdingCount === null ? UNKNOWN : String(group.holdingCount);
}
