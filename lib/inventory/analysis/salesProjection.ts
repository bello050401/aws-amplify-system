import type { SalesSourceRecord } from '../sales';
import { integer } from './normalize';
import { sourceDay } from './period';
import type { AnalysisSource } from './types';

type Source = AnalysisSource & { shippingCost?: number | null };

/**
 * A generation captures only closed, non-deleted sales dated at or before its
 * cutoff. Convert offset timestamps to their JST calendar date before feeding
 * either model. The standalone legacy calculator still accepts its original
 * input contract.
 */
export function normalizedCapturedSalesRecords(rows: readonly Source[], asOf: string): SalesSourceRecord[] {
  const captured: SalesSourceRecord[] = [];
  for (const row of rows) {
    if (row.deletedAt) continue;
    const saleEndDate = sourceDay(row.saleEndDate, asOf);
    if (!saleEndDate) continue;
    captured.push({
      id: row.id, displayId: row.sku ?? '', sku: row.sku ?? '', name: row.name ?? '', saleEndDate,
      salePrice: integer(row.salePrice), purchasePrice: row.purchasePrice ?? null, shippingCost: row.shippingCost ?? null,
    });
  }
  return captured;
}
