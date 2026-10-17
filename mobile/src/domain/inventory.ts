import { copyDetailValues, validateDetailValues, type DetailValues } from "./detailFields";

export interface InventoryPhoto {
  id: string; url: string | null; primary: boolean;
  fullUrl?: string | null;
  type?: "NORMAL" | "DAMAGE";
  source?: "INVENTORY" | "PHOTO_ASSET";
}
export interface InventoryStatusOption { id: string; label: string }
export interface InventoryItem {
  id: string;
  sku: string;
  /** Existing BELLO display ID (ZAICO ID for imported products); sku remains the management number. */
  displayId?: string;
  name: string;
  quantity: number;
  unit: string;
  location: string;
  category: string;
  condition: string;
  /** BELLO StatusMaster ID and choices. condition is its display label, not a separate saved field. */
  statusId?: string | null;
  statusOptions?: InventoryStatusOption[];
  note: string;
  barcode: string;
  plannedSalePrice: number | null;
  thumbnailUrl: string | null;
  updatedAt: string;
  details?: DetailValues;
  photos?: InventoryPhoto[];
  photosComplete?: boolean;
  detailLoadedAt?: string;
}

export type InventoryDraft = {
  name: string;
  quantity: string;
  unit: string;
  location: string;
  category: string;
  condition: string;
  statusId: string;
  note: string;
  barcode: string;
  plannedSalePrice: string;
  details: DetailValues;
};

export function draftFor(item: InventoryItem): InventoryDraft {
  return {
    name: item.name, quantity: String(item.quantity), unit: item.unit,
    location: item.location, category: item.category, condition: item.condition, statusId: item.statusId ?? "",
    note: item.note, barcode: item.barcode,
    plannedSalePrice: item.plannedSalePrice === null ? "" : String(item.plannedSalePrice),
    details: copyDetailValues(item.details),
  };
}

export function sameDraft(a: InventoryDraft, b: InventoryDraft): boolean {
  const keys = new Set([...Object.keys(a.details), ...Object.keys(b.details)]);
  return (Object.keys(a) as (keyof InventoryDraft)[]).filter(key => key !== "details").every((key) => a[key] === b[key]) &&
    [...keys].every(key => (a.details[key] ?? "") === (b.details[key] ?? ""));
}

export function validateDraft(draft: InventoryDraft): string | null {
  if (!draft.name.trim()) return "物品名を入力してください。";
  if (!/^\d+$/.test(draft.quantity) || !Number.isSafeInteger(Number(draft.quantity))) {
    return "数量は0以上の整数で入力してください。";
  }
  if (draft.plannedSalePrice !== "" &&
      (!/^\d+$/.test(draft.plannedSalePrice) || !Number.isSafeInteger(Number(draft.plannedSalePrice)))) {
    return "販売予定価格は0以上の整数で入力してください。";
  }
  return validateDetailValues(draft.details);
}

/** Preserve details on a list refresh only while the server version remains identical. */
export function mergeInventoryRead(previous: InventoryItem[], current: InventoryItem[]): InventoryItem[] {
  const cached = new Map(previous.map(item => [item.id, item]));
  return current.map(item => {
    const old = cached.get(item.id);
    return old?.detailLoadedAt && old.updatedAt === item.updatedAt ? { ...old, ...item } : item;
  });
}
