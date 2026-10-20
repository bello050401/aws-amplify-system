import type { InventoryItem } from "./inventory";
import { copyDetailValues, isDetailValues } from "./detailFields";

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface InventorySnapshot {
  schema: 1;
  owner: string;
  fetchedAt: string;
  items: InventoryItem[];
}
export function isInventoryItem(value: unknown): value is InventoryItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["id", "sku", "name", "unit", "location", "category", "condition", "note", "barcode", "updatedAt"]
    .every((key) => typeof row[key] === "string") &&
    (row.displayId === undefined || typeof row.displayId === "string") &&
    (row.createdAt === undefined || typeof row.createdAt === "string") &&
    // Imported or historical records can contain negative stock. Keep the actual
    // value readable instead of rejecting the entire list; edits validate separately.
    typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) &&
    (row.quantityUnset === undefined || typeof row.quantityUnset === "boolean") &&
    (row.zaicoOriginalValues === undefined || (Array.isArray(row.zaicoOriginalValues) && row.zaicoOriginalValues.every(value =>
      value && typeof value.field === "string" && typeof value.name === "string" && typeof value.value === "string"))) &&
    (row.plannedSalePrice === null || (typeof row.plannedSalePrice === "number" && Number.isFinite(row.plannedSalePrice))) &&
    (row.thumbnailUrl === null || typeof row.thumbnailUrl === "string") &&
    (row.statusId === undefined || row.statusId === null || typeof row.statusId === "string") &&
    (row.statusOptions === undefined || (Array.isArray(row.statusOptions) && row.statusOptions.every(option =>
      option && typeof option.id === "string" && typeof option.label === "string"))) &&
    [row.categoryOptions,row.locationOptions].every(options => options === undefined || (Array.isArray(options) && options.every(value => typeof value === "string"))) &&
    (row.details === undefined || isDetailValues(row.details)) &&
    (row.detailLoadedAt === undefined || (typeof row.detailLoadedAt === "string" && Number.isFinite(Date.parse(row.detailLoadedAt)))) &&
    (row.photosComplete === undefined || typeof row.photosComplete === "boolean") &&
    (row.photos === undefined || (Array.isArray(row.photos) && row.photos.every(photo =>
      photo && typeof photo.id === "string" && typeof photo.primary === "boolean" &&
      (photo.url === null || (typeof photo.url === "string" && photo.url.startsWith("https://"))) &&
      (photo.fullUrl === undefined || photo.fullUrl === null || (typeof photo.fullUrl === "string" && photo.fullUrl.startsWith("https://"))) &&
      (photo.type === undefined || ["NORMAL", "DAMAGE"].includes(photo.type)) &&
      (photo.source === undefined || ["INVENTORY", "PHOTO_ASSET"].includes(photo.source)))));
}

/** Only confirmed reads/writes enter this cache; unsaved drafts are separate. */
export class SnapshotStore {
  private key: string;
  private active = true;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private storage: KeyValueStore, private owner: string, environment: string) {
    if (!owner || !environment) throw new Error("A signed-in account and environment are required.");
    this.key = `bello.inventory.v1.${encodeURIComponent(environment)}.${encodeURIComponent(owner)}`;
  }

  async read(): Promise<InventorySnapshot | null> {
    if (!this.active) return null;
    const raw = await this.storage.getItem(this.key);
    if (!raw || !this.active) return null;
    try {
      const value = JSON.parse(raw) as InventorySnapshot;
      if (value.schema !== 1 || value.owner !== this.owner || !Number.isFinite(Date.parse(value.fetchedAt)) ||
          !Array.isArray(value.items) || value.items.length > 500 || !value.items.every(isInventoryItem)) return null;
      return value;
    } catch { return null; }
  }

  async write(items: InventoryItem[], fetchedAt: string): Promise<void> {
    if (!this.active) return;
    if (!items.every(isInventoryItem) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("Invalid inventory snapshot.");
    const snapshot: InventorySnapshot = { schema: 1, owner: this.owner, fetchedAt, items: items.slice(0, 500).map(item => ({
      id: item.id, sku: item.sku, name: item.name, quantity: item.quantity, unit: item.unit,
      ...(item.quantityUnset !== undefined ? {quantityUnset:item.quantityUnset} : {}),
      ...(item.zaicoOriginalValues ? {zaicoOriginalValues:item.zaicoOriginalValues.map(value=>({...value}))} : {}),
      ...(item.displayId !== undefined ? { displayId: item.displayId } : {}),
      ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
      location: item.location, category: item.category, condition: item.condition, note: item.note,
      ...(item.statusId !== undefined ? { statusId: item.statusId } : {}),
      ...(item.statusOptions ? { statusOptions: item.statusOptions.map(option => ({ id: option.id, label: option.label })) } : {}),
      ...(item.categoryOptions ? {categoryOptions:[...item.categoryOptions]} : {}),
      ...(item.locationOptions ? {locationOptions:[...item.locationOptions]} : {}),
      barcode: item.barcode, plannedSalePrice: item.plannedSalePrice, thumbnailUrl: item.thumbnailUrl, updatedAt: item.updatedAt,
      ...(item.details ? { details: copyDetailValues(item.details) } : {}),
      ...(item.detailLoadedAt ? { detailLoadedAt: item.detailLoadedAt } : {}),
      ...(item.photosComplete !== undefined ? { photosComplete: item.photosComplete } : {}),
      ...(item.photos ? { photos: item.photos.map(photo => ({ id: photo.id, url: photo.url, primary: photo.primary,
        ...(photo.fullUrl !== undefined ? { fullUrl: photo.fullUrl } : {}), ...(photo.type ? { type: photo.type } : {}), ...(photo.source ? { source: photo.source } : {}),
      })) } : {}),
    })) };
    const serialized = JSON.stringify(snapshot);
    const write = this.operations.then(async () => {
      if (this.active) await this.storage.setItem(this.key, serialized);
    });
    this.operations = write.catch(() => {});
    await write;
  }

  async clearOnLogout(): Promise<void> {
    this.active = false;
    await this.operations;
    await this.storage.removeItem(this.key);
  }
}
