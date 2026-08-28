import "server-only";
import ExcelJS from "exceljs";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { listCategories, listCustomFieldDefinitions, listLocations, listStatuses, type InventoryListFilters } from "./queries";
import { parseCustomFields } from "./customFieldsCodec";
import { STATIC_EXPORT_FIELDS, type ExportFieldDef } from "./exportFields";
import { toCsv } from "./csv";

type InventoryModel = Schema["Inventory"]["type"];

/**
 * 在庫データのエクスポート (統合改善指示書 §11)。CSV/Excel、両方とも
 * この1つのモジュールが行/ヘッダーを組み立て、フォーマットだけが分岐
 * する — 「業務データの取り出し方」と「ファイル形式」を分離しておく
 * ことで、将来フォーマットが増えても行の組み立てをもう一度書かずに済
 * む。画像はバイナリはもちろん、内部S3キーそのものも出力しない
 * (spec §11-4: 内部S3構造を不用意に外部公開しない) — 「画像枚数」だ
 * けを出力する。
 */

/** 検索/絞り込み結果のエクスポート用に、lib/inventory/queries.tsのlistInventoryと同じフィルタ条件を再構築する — filterのビルドロジックそのものは重複させず、その関数と同じ形の`filters`をそのままAppSyncのfilter式へ変換する専用の軽量版(ページング不要、全件を集める点だけが違う)。 */
function buildFilterConditions(filters: InventoryListFilters): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [{ deletedAt: { attributeExists: false } }];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });
  if (filters.q) conditions.push({ or: [{ name: { contains: filters.q } }, { sku: { contains: filters.q } }] });
  return conditions;
}

/**
 * Fetches every matching Inventory row, paginating through AppSync's
 * nextToken in chunks rather than one unbounded query (spec §18: 大量
 * データでもブラウザ/APIを詰まらせない) — the same chunked-prefetch
 * shape lib/inventory/zaicoSync.ts's fetchAllZaicoManagedInventory
 * already uses for a full scan.
 */
async function fetchAllForExport(filters: InventoryListFilters): Promise<InventoryModel[]> {
  const items: InventoryModel[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.list({
      filter: { and: buildFilterConditions(filters) },
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`在庫データの取得に失敗しました: ${JSON.stringify(errors)}`);
    items.push(...data);
    nextToken = nt;
  } while (nextToken);
  return items;
}

function formatCellValue(value: unknown, valueType: ExportFieldDef["valueType"]): string | number {
  if (value === null || value === undefined || value === "") return "";
  if (valueType === "number") return typeof value === "number" ? value : Number(value) || "";
  if (valueType === "date") return String(value).replace(/-/g, "/"); // AWSDate "YYYY-MM-DD" → "YYYY/MM/DD"
  if (valueType === "datetime") {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return String(value);
}

export interface InventoryExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/**
 * `scope`: "filtered" applies `filters` exactly like the list page's own
 * search/絞り込み (絞り込み結果のエクスポート); "all" ignores them
 * entirely (全在庫). Both go through the same fetchAllForExport/row
 * builder — scope is just which filters get passed in.
 */
export async function buildInventoryExport(
  format: "csv" | "xlsx",
  filters: InventoryListFilters,
): Promise<InventoryExportResult> {
  const [categories, locations, statuses, customFieldDefs, items] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
    fetchAllForExport(filters),
  ]);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const statusesById = new Map(statuses.map((s) => [s.id, s]));

  const customFieldColumns: ExportFieldDef[] = customFieldDefs.map((def) => ({
    key: def.fieldKey,
    label: def.label,
    valueType: def.fieldType === "NUMBER" ? "number" : "string",
    importable: true,
  }));
  const columns: ExportFieldDef[] = [...STATIC_EXPORT_FIELDS, ...customFieldColumns];

  const rows: Record<string, string | number>[] = items.map((item) => {
    const customFields = parseCustomFields(item.customFields) ?? {};
    const raw: Record<string, unknown> = {
      sku: item.sku,
      name: item.name,
      categoryName: item.categoryId ? (categoriesById.get(item.categoryId)?.name ?? "") : "",
      locationName: item.locationId ? (locationsById.get(item.locationId)?.name ?? "") : "",
      statusLabel: item.statusId ? (statusesById.get(item.statusId)?.label ?? "") : "",
      quantity: item.quantity ?? 0,
      unit: item.unit ?? "",
      purchasePrice: item.purchasePrice ?? "",
      salePrice: item.salePrice ?? "",
      barcode: item.barcode ?? "",
      note: item.note ?? "",
      imageCount: (item.images ?? []).filter(Boolean).length,
      sourceSystem: item.sourceSystem ?? "",
      sourceInventoryId: item.sourceInventoryId ?? "",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      createdBy: item.createdBy ?? "",
      updatedBy: item.updatedBy ?? "",
    };
    for (const col of STATIC_EXPORT_FIELDS) {
      if (raw[col.key] === undefined) raw[col.key] = (item as unknown as Record<string, unknown>)[col.key] ?? "";
    }
    for (const col of customFieldColumns) raw[col.key] = customFields[col.key] ?? "";

    const row: Record<string, string | number> = {};
    for (const col of columns) row[col.key] = formatCellValue(raw[col.key], col.valueType);
    return row;
  });

  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  if (format === "csv") {
    const csv = toCsv(
      columns.map((c) => c.label),
      rows.map((r) => columns.map((c) => String(r[c.key] ?? ""))),
    );
    return { buffer: Buffer.from(csv, "utf-8"), filename: `bello-inventory-${timestamp}.csv`, contentType: "text/csv; charset=utf-8" };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("在庫データ");
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(10, Math.min(30, c.label.length * 2 + 4)) }));
  for (const row of rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    filename: `bello-inventory-${timestamp}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}
