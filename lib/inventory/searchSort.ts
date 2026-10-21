import type { SearchFieldDef } from "./advancedSearch";
import {productDateValue} from './productDates';

export interface InventorySort { field: string; direction: "asc" | "desc" }
export const DEFAULT_INVENTORY_SORT: InventorySort = { field: "updatedAt", direction: "desc" };
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/** Sort the entire matching set before pagination. Master IDs sort by visible names. */
export function inventoryComparator(sort: InventorySort, fields: Map<string, SearchFieldDef>) {
  const def = fields.get(sort.field);
  const labels = new Map(def?.options?.map(option => [option.value, option.label]) ?? []);
  const value = (row: Record<string, unknown>) => {
    const raw = sort.field.startsWith("cf:") ? (row.customFields as Record<string, unknown> | null)?.[sort.field.slice(3)] : productDateValue(row,sort.field);
    return labels.get(String(raw)) ?? raw;
  };
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const av = value(a), bv = value(b);
    const aEmpty = av == null || av === "", bEmpty = bv == null || bv === "";
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    const compared = def?.valueType === "number" && !aEmpty ? Number(av) - Number(bv) : collator.compare(String(av ?? ""), String(bv ?? ""));
    const direction = sort.direction === "asc" ? 1 : -1;
    if (Number.isFinite(compared) && compared !== 0) return compared * direction;
    // ZAICO uses the same direction for inventory IDs when product dates tie.
    // Old imports often share midnight timestamps, so this also defines pages.
    const dateTie = sort.field === 'createdAt' || sort.field === 'updatedAt';
    return collator.compare(String(a.sourceInventoryId ?? a.id), String(b.sourceInventoryId ?? b.id)) * (dateTie ? direction : -1) || 0;
  };
}
