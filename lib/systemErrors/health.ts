import type { AnalysisResult } from '../inventory/analysis/types';
import type { UsedGoodsLedger } from '../inventory/usedGoodsLedger';
import type { SystemErrorSignal } from './contract';

export type FeatureCheck = NonNullable<SystemErrorSignal['check']>;

// Compare integer money/counts without rounding errors or overflow. These
// observations never repair data, and no business values leave this module.
function matchesSum(expected: number, values: readonly number[]): boolean {
  if (!Number.isSafeInteger(expected) || values.some(value => !Number.isSafeInteger(value))) return false;
  return values.reduce((total, value) => total + BigInt(value), 0n) === BigInt(expected);
}

/** Each ordinary dimension partitions the same captured records. SKU-only
 * dimensions omit unassigned records, so only their SKU count is comparable. */
export function inspectAnalysisHealth(result: AnalysisResult): FeatureCheck[] {
  if (result.status !== 'ok') return [];
  const found = new Set<FeatureCheck>();
  const summary = result.summary;
  if (!summary || !summary.dimensions) return ['aggregate-total-mismatch'];
  if (!matchesSum(summary.amount,[summary.gross,-summary.returns])) found.add('aggregate-total-mismatch');
  if (!matchesSum(summary.quantity,[summary.grossQuantity,-summary.returnedQuantity])) found.add('quantity-total-mismatch');
  for (const [dimension,buckets] of Object.entries(summary.dimensions)) {
    if (!Array.isArray(buckets)) {found.add('category-total-mismatch');continue;}
    if (dimension === 'skuCategory' || dimension === 'skuHoldingCount') {
      if (summary.skus !== undefined && !matchesSum(summary.skus,buckets.map(bucket=>bucket.skus ?? NaN))) found.add('quantity-total-mismatch');
      continue;
    }
    if (!matchesSum(summary.amount,buckets.map(bucket=>bucket.amount)) ||
        !matchesSum(summary.gross,buckets.map(bucket=>bucket.gross)) ||
        !matchesSum(summary.returns,buckets.map(bucket=>bucket.returns))) found.add('category-total-mismatch');
    if (!matchesSum(summary.quantity,buckets.map(bucket=>bucket.quantity)) ||
        !matchesSum(summary.records,buckets.map(bucket=>bucket.records)) ||
        !matchesSum(summary.grossQuantity,buckets.map(bucket=>bucket.grossQuantity)) ||
        !matchesSum(summary.returnedQuantity,buckets.map(bucket=>bucket.returnedQuantity))) found.add('quantity-total-mismatch');
  }
  // Older/mismatched snapshots must never be compared as if they were current.
  if (result.target === 'inventory' && result.inventoryValue && result.metadata &&
      result.inventoryValue.asOf === result.metadata.asOf) {
    if (!matchesSum(result.inventoryValue.total,[summary.amount])) found.add('aggregate-total-mismatch');
    if (!matchesSum(result.inventoryValue.quantity,[summary.quantity])) found.add('quantity-total-mismatch');
  }
  return [...found];
}

/** Unknown amounts and existing record-quality issues are not software defects.
 * Only check arithmetic where all three registered values are available. */
export function inspectLedgerHealth(ledger: UsedGoodsLedger): FeatureCheck[] {
  const collections = [ledger.rows,ledger.transactions,ledger.supplierDays];
  if (collections.some(value=>!Array.isArray(value))) return ['export-row-mismatch'];
  for (const rows of collections) {
    for (const row of rows) {
      if (row.purchaseAmount == null || row.shipping == null || row.total == null) continue;
      if (!matchesSum(row.total,[row.purchaseAmount,row.shipping])) return ['aggregate-total-mismatch'];
    }
  }
  return [];
}
