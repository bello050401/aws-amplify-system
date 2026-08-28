import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { parseCustomFields } from "./customFieldsCodec";
import type { InventoryExtendedFields } from "./extendedFields";
import { normalizeImageRecord, resolveTopImage, type InventoryImageRecord } from "./imageTypes";

type InventoryModel = Schema["Inventory"]["type"];

export interface InventoryListFilters {
  q?: string; // matches name OR sku, partial
  /** OR across every selected category (spec: 複数選択時はOR条件) — an empty/absent array means no category filter at all, not "match nothing". */
  categoryIds?: string[];
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
  // Phase C — kept on the list row (unlike the rest of extendedFields,
  // which is detail-only) since it's a default-visible list column; see
  // lib/inventory/listColumns.ts.
  plannedSalePrice: number | null;
  note: string | null;
  mainImageStorageKey: string | null;
  createdAt: string;
  updatedAt: string;
  // Additional optional list columns (統合改善指示書 §10) — the same
  // extendedFields already readable on the detail/edit screens, now also
  // available as opt-in list columns. See lib/inventory/listColumns.ts
  // for which ones actually show by default.
  barcode: string | null;
  saleCommission: number | null;
  market: string | null;
  saleStartDate: string | null;
  saleEndDate: string | null;
  width: string | null;
  depth: string | null;
  height: string | null;
  conditionRating: string | null;
  damageNotes: string | null;
  transactionDate: string | null;
  transactionType: string | null;
  adminMemo: string | null;
}

/** Every image on the record, normalized (legacy rows with no `type` read as NORMAL — see lib/inventory/imageTypes.ts). Shared by toListRow (just needs the resolved top image) and getInventoryDetail (needs the full normal/damage breakdown). */
function normalizedImages(item: InventoryModel): InventoryImageRecord[] {
  return (item.images ?? []).filter((img): img is NonNullable<typeof img> => Boolean(img)).map(normalizeImageRecord);
}

function toListRow(item: InventoryModel): InventoryListRow {
  const images = normalizedImages(item);
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
    plannedSalePrice: item.plannedSalePrice ?? null,
    note: item.note ?? null,
    // Phase C.5: the explicit top image (isPrimary, falling back to the
    // first NORMAL image) rather than simply `images[0]` — a damage
    // photo can never end up as the list thumbnail even if it happens to
    // sort first. See resolveTopImage's own comment.
    mainImageStorageKey: resolveTopImage(images)?.storageKey ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    barcode: item.barcode ?? null,
    saleCommission: item.saleCommission ?? null,
    market: item.market ?? null,
    saleStartDate: item.saleStartDate ?? null,
    saleEndDate: item.saleEndDate ?? null,
    width: item.width ?? null,
    depth: item.depth ?? null,
    height: item.height ?? null,
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    transactionDate: item.transactionDate ?? null,
    transactionType: item.transactionType ?? null,
    adminMemo: item.adminMemo ?? null,
  };
}

/** Every Phase C field mapped to `T | null` (instead of extendedFields.ts's `T | undefined`, used for form-state parsing) — this is what a fully-read Inventory record actually looks like: every field always present on the object, absent ones simply null. Derived from InventoryExtendedFields with `type` rather than re-listed, so the two can't drift apart. */
type ExtendedFieldsAsNullable = { [K in keyof InventoryExtendedFields]-?: NonNullable<InventoryExtendedFields[K]> | null };

function toExtendedFields(item: InventoryModel): ExtendedFieldsAsNullable {
  return {
    barcode: item.barcode ?? null,
    plannedSalePrice: item.plannedSalePrice ?? null,
    firstMarkdownPrice: item.firstMarkdownPrice ?? null,
    secondMarkdownPrice: item.secondMarkdownPrice ?? null,
    thirdMarkdownPrice: item.thirdMarkdownPrice ?? null,
    saleStartDate: item.saleStartDate ?? null,
    saleEndDate: item.saleEndDate ?? null,
    market: item.market ?? null,
    externalProductId: item.externalProductId ?? null,
    saleCommission: item.saleCommission ?? null,
    listingNotes: item.listingNotes ?? null,
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    width: item.width ?? null,
    depth: item.depth ?? null,
    height: item.height ?? null,
    overallLength: item.overallLength ?? null,
    lengthAdjustable: item.lengthAdjustable ?? null,
    mountType: item.mountType ?? null,
    usedGoodsItemType: item.usedGoodsItemType ?? null,
    transactionDate: item.transactionDate ?? null,
    purchaseQuantity: item.purchaseQuantity ?? null,
    transactionType: item.transactionType ?? null,
    identityVerificationMethod: item.identityVerificationMethod ?? null,
    counterpartyName: item.counterpartyName ?? null,
    counterpartyOccupation: item.counterpartyOccupation ?? null,
    counterpartyAddress: item.counterpartyAddress ?? null,
    shippingCost: item.shippingCost ?? null,
    dailyPurchaseTotal: item.dailyPurchaseTotal ?? null,
    adminMemo: item.adminMemo ?? null,
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
  // 複数カテゴリはOR条件（いずれかに一致）、他の条件とはAND — spec §9。
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
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

export interface InventoryDetail extends InventoryListRow, ExtendedFieldsAsNullable {
  images: InventoryImageRecord[]; // both NORMAL and DAMAGE, normalized — callers split via lib/inventory/imageTypes.ts's splitImagesByType
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

  return {
    ...toListRow(item),
    ...toExtendedFields(item),
    images: normalizedImages(item),
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

/**
 * Master tables are small (admin-managed lists), so a plain full list —
 * sorted client-side by sortOrder then name — is the natural fit here,
 * unlike the cursor-paginated Inventory list above.
 *
 * `includeInactiveId`: a record that has since been deactivated in
 * /inventory/settings must not vanish from a form that's currently
 * displaying it — an Inventory row that already references it still
 * needs to show/keep that value (spec: 無効化しても既存参照は壊さない).
 * Only the one id already on the record being viewed/edited is ever
 * added this way, never the full inactive set — this stays a small,
 * targeted lookup, not a second full table scan. It's suffixed
 * "（無効）" so it reads as a deactivated option, not an active choice
 * a user could newly pick some other way.
 */
export async function listCategories(includeInactiveId?: string | null): Promise<MasterOption[]> {
  const { data } = await serverDataClient.models.Category.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  const options = data
    .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null, sortOrder: c.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));

  if (includeInactiveId && !options.some((o) => o.id === includeInactiveId)) {
    const { data: inactive } = await serverDataClient.models.Category.get({ id: includeInactiveId }, inventoryAuthMode);
    if (inactive) {
      options.push({ id: inactive.id, name: `${inactive.name}（無効）`, parentId: inactive.parentId ?? null, sortOrder: inactive.sortOrder ?? 0 });
    }
  }
  return options;
}

export async function listLocations(includeInactiveId?: string | null): Promise<MasterOption[]> {
  const { data } = await serverDataClient.models.Location.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  const options = data
    .map((l) => ({ id: l.id, name: l.name, parentId: l.parentId ?? null, sortOrder: l.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));

  if (includeInactiveId && !options.some((o) => o.id === includeInactiveId)) {
    const { data: inactive } = await serverDataClient.models.Location.get({ id: includeInactiveId }, inventoryAuthMode);
    if (inactive) {
      options.push({ id: inactive.id, name: `${inactive.name}（無効）`, parentId: inactive.parentId ?? null, sortOrder: inactive.sortOrder ?? 0 });
    }
  }
  return options;
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
