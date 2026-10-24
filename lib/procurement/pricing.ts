export const PROCUREMENT_PRICING = {
  RESTAGE: { multiplier: '1.188', numerator: 1188 },
  TREFAC: { multiplier: '1.21', numerator: 1210 },
} as const;
export type ProcurementProvider = keyof typeof PROCUREMENT_PRICING;

/** Round the final yen amount once, after division for a bundled lot. */
export function procurementPurchasePrice(provider: ProcurementProvider, hammerPrice: number, quantity = 1, isBundle = false) {
  if (!Number.isSafeInteger(hammerPrice) || hammerPrice <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) throw Error('落札価格または数量が不正です。');
  const denominator = 1000 * (isBundle ? quantity : 1);
  const numerator = hammerPrice * PROCUREMENT_PRICING[provider].numerator;
  if (!Number.isSafeInteger(numerator + denominator / 2)) throw Error('落札価格が入力上限を超えています。');
  return Math.floor((numerator + denominator / 2) / denominator);
}
