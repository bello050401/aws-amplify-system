import 'server-only';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { inventoryDdb } from '@/lib/inventory/categoryPersistence';
import type { ProductMatch } from './types';

export function confirmedBaseBinding(row: Record<string, unknown> | undefined, inventoryId: string, baseIds: readonly string[]): boolean {
  const baseline = row?.baseline && typeof row.baseline === 'object' ? row.baseline as Record<string, unknown> : undefined;
  const base = baseline?.BASE && typeof baseline.BASE === 'object' ? baseline.BASE as Record<string, unknown> : undefined;
  return !!row && row.pk === 'ECONVENI#MANUAL_LINK#' + inventoryId
    && row.inventoryId === inventoryId && !!row.linkedAt && !!row.productId
    && baseIds.includes(String(base?.listingId ?? ''));
}

/** Inspect only existing operator-confirmed links for plausible candidates. No external writes. */
export async function confirmCandidatesByBaseBinding(candidates: ProductMatch[], baseIds: string[]): Promise<ProductMatch[]> {
  if (!baseIds.length) return candidates;
  return Promise.all(candidates.map(async candidate => {
    try {
      const { Item } = await inventoryDdb.send(new GetCommand({
        TableName: 'BelloEconveniWorkflow', Key: { pk: 'ECONVENI#MANUAL_LINK#' + candidate.inventoryId }, ConsistentRead: true,
      }));
      if (confirmedBaseBinding(Item, candidate.inventoryId, baseIds)) return {
        ...candidate, confidence: 1, reasons: [...candidate.reasons, '確認済みのeコンビニ連携先BASE商品IDが一致'],
      };
    } catch {
      console.warn('[inquiry] Confirmed listing binding unavailable');
    }
    return candidate;
  }));
}
