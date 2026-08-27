import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { parseCustomFields } from "./customFieldsCodec";

type InventoryModel = Schema["Inventory"]["type"];

export interface InventoryListFilters {
  q?: string; // matches name OR sku, partial
  categoryId?: string;
  locationId?: string;
  statusId?: string;
}

export interface InventoryListRow {
  id: string;
  sku: string;
  name: string;
  categoryId: string | null;
  statusId: string | null;
  locationId: string | null;
  quantity: number;
  unit: string | null;
  purchasePrice: number | null;
  salePrice: number | null;
  note: string | null;
  mainImageStorageKey: string | null;
  createdAt: string;
  updatedAt: string;
}

function toListRow(item: InventoryModel): InventoryListRow {
  const images = [...(item.images ?? [])].sort((a, b) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0));
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    categoryId: item.categoryId ?? null,
    statusId: item.statusId ?? null,
    locationId: item.locationId ?? null,
    quantity: item.quantity ?? 0,
    unit: item.unit ?? null,
    purchasePrice: item.purchasePrice ?? null,
    salePrice: item.salePrice ?? null,
    note: item.note ?? null,
    mainImageStorageKey: images[0]?.storageKey ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Cursor-paginated list (AppSync `nextToken`), NOT "fetch everything and
 * paginate client-side" — spec §27 explicitly rules that out so this
 * still holds up once inventory count grows well past what fits in one
 * response. `includeDeleted` powers the separate 削除済み在庫 screen
 * (not built in Phase 3, but the query already supports it so that
 * screen is additive later, not a rework of this one).
 */
export async function listInventory(
  filters: InventoryListFilters,
  options: { cursor?: string; limit?: number; includeDeleted?: boolean } = {},
) {
  const conditions: Record<string, unknown>[] = [
    { deletedAt: { attributeExists: Boolean(options.includeDeleted) } },
  ];
  if (filters.categoryId) conditions.push({ categoryId: { eq: filters.categoryId } });
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });
  if (filters.q) {
    conditions.push({
      or: [{ name: { contains: filters.q } }, { sku: { contains: filters.q } }],
    });
  }

  const { data, nextToken, errors } = await serverDataClient.models.Inventory.list({
    filter: { and: conditions },
    limit: options.limit ?? 50,
    nextToken: options.cursor,
    ...inventoryAuthMode,
  });

  if (errors) throw new Error(`在庫一覧の取得に失敗しました: ${JSON.stringify(errors)}`);

  return {
    items: data.map(toListRow),
    nextToken: nextToken ?? null,
  };
}

export interface InventoryHistoryRow {
  id: string;
  changedAt: string;
  changedBy: string | null;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface InventoryDetail extends InventoryListRow {
  images: { storageKey: string; sortOrder: number }[];
  customFields: Record<string, unknown> | null;
  createdBy: string | null;
  updatedBy: string | null;
  history: InventoryHistoryRow[];
}

export async function getInventoryDetail(id: string): Promise<InventoryDetail | null> {
  const { data: item } = await serverDataClient.models.Inventory.get({ id }, inventoryAuthMode);
  if (!item || item.deletedAt) return null;

  const { data: historyRows } = await serverDataClient.models.InventoryHistory.list({
    filter: { inventoryId: { eq: id } },
    ...inventoryAuthMode,
  });

  const images = [...(item.images ?? [])]
    .filter((img): img is { storageKey: string; sortOrder: number } => Boolean(img))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    ...toListRow(item),
    images,
    customFields: parseCustomFields(item.customFields),
    createdBy: item.createdBy ?? null,
    updatedBy: item.updatedBy ?? null,
    history: historyRows
      .map((h) => ({
        id: h.id,
        changedAt: h.changedAt,
        changedBy: h.changedBy ?? null,
        fieldName: h.fieldName,
        oldValue: h.oldValue ?? null,
        newValue: h.newValue ?? null,
      }))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt)),
  };
}

export interface MasterOption {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

/** Master tables are small (admin-managed lists), so a plain full list — sorted client-side by sortOrder then name — is the natural fit here, unlike the cursor-paginated Inventory list above. */
export async function listCategories(): Promise<MasterOption[]> {
  const { data } = await serverDataClient.models.Category.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data
    .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null, sortOrder: c.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
}

export async function listLocations(): Promise<MasterOption[]> {
  const { data } = await serverDataClient.models.Location.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data
    .map((l) => ({ id: l.id, name: l.name, parentId: l.parentId ?? null, sortOrder: l.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
}

export interface StatusOption {
  id: string;
  code: string;
  label: string;
  sortOrder: number;
}

export async function listStatuses(): Promise<StatusOption[]> {
  const { data } = await serverDataClient.models.StatusMaster.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data
    .map((s) => ({ id: s.id, code: s.code, label: s.label, sortOrder: s.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export interface CustomFieldDefinitionRow {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: Schema["CustomFieldType"]["type"];
  required: boolean;
  sortOrder: number;
  options: string[];
}

export async function listCustomFieldDefinitions(): Promise<CustomFieldDefinitionRow[]> {
  const { data } = await serverDataClient.models.CustomFieldDefinition.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data
    .map((f) => ({
      id: f.id,
      fieldKey: f.fieldKey,
      label: f.label,
      fieldType: f.fieldType,
      required: f.required ?? false,
      sortOrder: f.sortOrder ?? 0,
      options: (f.options ?? []).filter((o): o is string => Boolean(o)),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** SKU pre-create duplicate check (spec §7/§13) — a query, not a hard uniqueness guarantee; see createInventory in app/actions/inventory.ts for the accepted race-window tradeoff. */
export async function findInventoryBySku(sku: string): Promise<{ id: string; name: string } | null> {
  const { data } = await serverDataClient.models.Inventory.list({
    filter: { sku: { eq: sku } },
    ...inventoryAuthMode,
  });
  const match = data.find((i) => !i.deletedAt);
  return match ? { id: match.id, name: match.name } : null;
}
