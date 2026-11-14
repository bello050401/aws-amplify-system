import { positive, quantityBand, quantityClass } from './normalize';
import type { Fact } from './types';

export function withCurrentHoldingCounts(facts: Fact[]): Fact[] {
  if (facts.every(fact => fact.holdingCount !== undefined && fact.holdingBasis !== undefined)) return facts;

  const quantities = new Map<string, number | null>();
  for (const { kindId, quantity } of facts) {
    if (!kindId || quantities.get(kindId) === null) continue;
    const current = positive(quantity);
    const total = current === null ? null : (quantities.get(kindId) ?? 0) + current;
    if (total !== null && !Number.isSafeInteger(total)) throw new Error('ANALYSIS_QUANTITY_OVERFLOW');
    quantities.set(kindId, total);
  }
  return facts.map(fact => {
    if (fact.holdingCount !== undefined && fact.holdingBasis !== undefined) return fact;
    const kindQuantity = fact.kindId ? quantities.get(fact.kindId) ?? null : null;
    const holdingCount = fact.kindId ? kindQuantity : positive(fact.quantity);
    const holdingBasis = holdingCount === null ? 'unknown' : fact.kindId ? 'confirmed-kind' : 'inventory-record';
    return { ...fact, holdingCount, holdingBasis, holding: quantityClass(kindQuantity), holdingBand: quantityBand(kindQuantity) };
  });
}
