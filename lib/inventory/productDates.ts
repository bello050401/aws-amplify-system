/** User-visible product dates. updatedAt remains the database edit version. */
export function productUpdatedAt(row: {listUpdatedAt?: unknown; updatedAt?: unknown}): string {
  const value = row.listUpdatedAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : typeof row.updatedAt === 'string' ? row.updatedAt : '';
}
export function productDateValue(row: Record<string, unknown>, key: string): unknown {
  return key === 'updatedAt' ? productUpdatedAt(row) : row[key];
}
/** Stable ordering across pages, including imported products with the same second. */
export function compareInventoryDateDesc(a: {id:string;updatedAt:string;listUpdatedAt?:string|null;sourceInventoryId?:string|null}, b: {id:string;updatedAt:string;listUpdatedAt?:string|null;sourceInventoryId?:string|null}): number {
  return Date.parse(productUpdatedAt(b)) - Date.parse(productUpdatedAt(a)) ||
    String(b.sourceInventoryId ?? b.id).localeCompare(String(a.sourceInventoryId ?? a.id), 'en', {numeric:true});
}
