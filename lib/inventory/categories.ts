/** Master IDs are canonical. categoryId remains a compatibility projection. */
export interface CategoryRecord { categoryId?: string | null; categoryIds?: readonly (string | null)[] | null }
export function inventoryCategoryIds(row: CategoryRecord): string[] {
  return [...new Set((row.categoryIds ?? (row.categoryId ? [row.categoryId] : [])).filter((id): id is string => typeof id === 'string' && !!id))];
}
export function splitCategoryNames(value: string): string[] {
  return [...new Set(value.split(/[,，]/u).map(name => name.trim()).filter(Boolean))];
}
export function categoryFilter(id: string) {
  return { or: [{ categoryIds: { contains: id } }, { and: [{ categoryIds: { attributeExists: false } }, { categoryId: { eq: id } }] }] };
}
export function replaceMovementCategory(current: readonly string[], movementIds: readonly string[], selected: string | null): string[] {
  if (selected === null) return [...current];
  if (!movementIds.includes(selected)) throw new Error('移動先の設定を確認してください。');
  return [...new Set([...current.filter(id => !movementIds.includes(id)), selected])];
}
export function categoryLabels(row: CategoryRecord, masters: readonly {id:string;name:string}[]): string[] {
  const names=new Map(masters.map(m=>[m.id,m.name]));
  return inventoryCategoryIds(row).map(id=>names.get(id) ?? id);
}
