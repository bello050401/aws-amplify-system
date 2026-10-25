/** Physical stock and commercial units are separate (e.g. two chairs = one set). */
export interface SalePricing {
  mode: 'UNIT' | 'SET'; units: number; itemsPerUnit: number;
  unitPrice: number | null; unitCommission: number | null;
}
export function saleAmounts(p: SalePricing) {
  if (!p || !['UNIT','SET'].includes(p.mode) || !Number.isSafeInteger(p.units) || p.units < 1 ||
      !Number.isSafeInteger(p.itemsPerUnit) || p.itemsPerUnit < 1 || p.itemsPerUnit > 10000 ||
      (p.mode === 'UNIT' && p.itemsPerUnit !== 1) || (p.mode === 'SET' && p.itemsPerUnit < 2))
    throw Error('販売数量と1セットの点数を確認してください。');
  const quantity = p.units * p.itemsPerUnit;
  if (!Number.isSafeInteger(quantity)) throw Error('数量が大きすぎます。');
  const total = (n: number | null) => {
    if (n === null) return null;
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * p.units)))
      throw Error('単価と販売手数料を確認してください。');
    return Math.round(n * p.units);
  };
  if (p.unitPrice !== null && !Number.isSafeInteger(p.unitPrice)) throw Error('販売単価は1円単位で入力してください。');
  return {quantity, salePrice: total(p.unitPrice), saleCommission: total(p.unitCommission)};
}
export function saleTitle(name: string, p?: SalePricing) {
  if (!p || p.mode !== 'SET') return name.trim();
  return `【${p.itemsPerUnit}点セット】` + name.trim().replace(/^【\s*[0-9０-９]+\s*点セット】\s*/, '');
}
