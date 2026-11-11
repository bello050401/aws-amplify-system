import {readInventoryBatch} from './batchRead';
import {inventoryDdb,inventoryTable} from './categoryPersistence';
import {formatJstDateTime} from "@/lib/inventory/formatJst";
import {productUpdatedAt} from "./productDates";
import {NOT_MERGED_FILTER} from "@/lib/outbound/mergeInventory";
import { nowInJst } from "@/lib/inventory/sales";
import "server-only";
import ExcelJS from "exceljs";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { listCategories, listCustomFieldDefinitions, listLocations, listStatuses, type InventoryListFilters } from "./queries";
import { parseCustomFields } from "./customFieldsCodec";
import { STATIC_EXPORT_FIELDS, KNOWN_CUSTOM_FIELD_KEYS, type ExportFieldDef } from "./exportFields";
import { resolveDisplayInventoryId } from "./inventoryId";
import { buildSearchFieldDefs, createQuickSearchMatcher, evaluateQuery, type AdvancedSearchQuery, type SearchFieldDef, type SearchableRecord } from "./advancedSearch";
import { toCsv } from "./csv";
import { categoryFilter, inventoryCategoryIds } from "./categories";
import { inventoryComparator, type InventorySort } from "./searchSort";

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

/** 複数カテゴリと旧単一カテゴリを同じ条件で絞り込む。 */
export function buildCategoryLocationConditions(filters: Pick<InventoryListFilters, "categoryIds" | "locationId">): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map(categoryFilter) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  return conditions;
}

/**
 * 検索/絞り込み結果のエクスポート用に、lib/inventory/queries.tsの
 * listInventoryと同じフィルタ条件を再構築する — filterのビルドロジッ
 * クそのものは重複させず、その関数と同じ形の`filters`をそのまま
 * AppSyncのfilter式へ変換する専用の軽量版(ページング不要、全件を集
 * める点だけが違う)。
 *
 * `q`(自由文字列検索)はここに含めない — DynamoDBの`contains`は
 * case-sensitiveで、保存値をlowercase化することも禁止されているため
 * (夜間開発指示書 §6)、`q`はfetchAllForExportが全件取得した後、
 * lib/inventory/advancedSearch.tsのmatchesQuickSearchでcase-insensitive
 * に絞り込む(buildInventoryExport参照)。
 */
function buildFilterConditions(filters: InventoryListFilters): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [NOT_MERGED_FILTER, { deletedAt: { attributeExists: false } }, ...buildCategoryLocationConditions(filters)];
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });
  return conditions;
}

/**
 * Fetches every matching Inventory row, paginating through AppSync's
 * nextToken in chunks rather than one unbounded query (spec §18: 大量
 * データでもブラウザ/APIを詰まらせない) — the same chunked-prefetch
 * shape lib/inventory/zaicoSync.ts's fetchAllZaicoManagedInventory
 * already uses for a full scan.
 *
 * QA-006追加レビュー: 引数を`InventoryListFilters`ではなく組み立て済み
 * の`conditions`配列にした——単純検索/詳細検索のどちらでも同じ関数を
 * 経由させ、「詳細検索時はconditionsが空になる」という以前の暗黙の分岐
 * をbuildInventoryExport側の1箇所に集約するため。
 */
async function fetchAllForExport(conditions: Record<string, unknown>[]): Promise<InventoryModel[]> {
  const items: InventoryModel[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.list({
      filter: { and: conditions },
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
    return formatJstDateTime(String(value));
  }
  return String(value);
}

export interface InventoryExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** 生のInventoryModelをlib/inventory/advancedSearch.tsの判定関数が読める最小限の形へ変換する — フィールド名はInventoryModelとSearchableRecordで一致しているため、customFields(生JSON文字列→パース済みオブジェクト)とdisplayId(導出値)だけ補えばよい。行の組み立て(下のitems.map)には一切使わない、詳細検索の絞り込み専用のアダプタ。 */
function toSearchableRecordFromRaw(item: InventoryModel): SearchableRecord {
  return {
    ...item,
    quantity: item.quantity ?? 0,
    customFields: parseCustomFields(item.customFields),
    displayId: resolveDisplayInventoryId({ sourceSystem: item.sourceSystem ?? null, sourceInventoryId: item.sourceInventoryId ?? null, sku: item.sku }),
  } as unknown as SearchableRecord;
}

/** 一覧と同じ検索条件・並べ替えを全結果に適用してCSV/Excelを作成する。 */
export async function buildInventoryExport(
  format: "csv" | "xlsx",
  filters: InventoryListFilters,
  advanced?: { query: AdvancedSearchQuery; fieldsByKey: Map<string, SearchFieldDef> },
  sort?: InventorySort,
  selectedIds?: readonly string[],
): Promise<InventoryExportResult> {
  const conditions = buildFilterConditions(filters);
  const [categories, locations, statuses, customFieldDefs, items] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
    selectedIds ? fetchSelectedForExport(selectedIds) : fetchAllForExport(conditions),
  ]);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const statusesById = new Map(statuses.map((s) => [s.id, s]));

  // 一覧と同じく、詳細条件と自由文字列検索の両方を満たす行を出力する。
  const match = createQuickSearchMatcher(filters.q ?? "");
  const filteredItems = items.filter(item => {
    const record = toSearchableRecordFromRaw(item);
    return (!advanced || evaluateQuery(record, advanced.query, advanced.fieldsByKey)) &&
      match(record);
  });
  if (sort) {
    const fields = new Map(buildSearchFieldDefs(customFieldDefs, {categories,locations,statuses}).map(f=>[f.key,f]));
    const compare = inventoryComparator(sort, fields);
    filteredItems.sort((a,b)=>compare(toSearchableRecordFromRaw(a),toSearchableRecordFromRaw(b)));
  }

  // KNOWN_CUSTOM_FIELD_KEYS(脚高/座面寸法/口金/梱包サイズ/古物の特徴/
  // 売却の優先度)はすでにSTATIC_EXPORT_FIELDS側にZAICO互換ラベルで
  // 列挙済み(ZAICO列順内の正しい位置に配置するため) — ここでもう一度
  // 列を足すと同じ項目が重複して出力されてしまうため除外する。管理者が
  // 今後追加した、それ以外のcustom fieldだけをここで末尾に足す。
  const customFieldColumns: ExportFieldDef[] = customFieldDefs
    .filter((def) => !KNOWN_CUSTOM_FIELD_KEYS.has(def.fieldKey))
    .map((def) => ({
      key: def.fieldKey,
      label: def.label,
      valueType: def.fieldType === "NUMBER" ? "number" : "string",
      importable: true,
    }));
  const columns: ExportFieldDef[] = [...STATIC_EXPORT_FIELDS, ...customFieldColumns];

  const rows: Record<string, string | number>[] = filteredItems.map((item) => {
    const customFields = parseCustomFields(item.customFields) ?? {};
    const raw: Record<string, unknown> = {
      // ZAICO互換ブロックの先頭列 — 表示用「在庫ID」(内部DB idでもSKU
      // でもない第3の値。lib/inventory/inventoryId.ts参照)。
      displayId: resolveDisplayInventoryId({ sourceSystem: item.sourceSystem ?? null, sourceInventoryId: item.sourceInventoryId ?? null, sku: item.sku }),
      sku: item.sku,
      name: item.name,
      categoryName: inventoryCategoryIds(item).map(id => categoriesById.get(id)?.name ?? id).join(","),
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
      updatedAt: productUpdatedAt(item),
      createdBy: item.createdBy ?? "",
      updatedBy: item.updatedBy ?? "",
      stocktakeDate: customFields.stocktakeDate ?? "",
      groupTag: customFields.groupTag ?? "",
    };
    for (const col of STATIC_EXPORT_FIELDS) {
      if (raw[col.key] !== undefined) continue;
      // ⚪︎脚高/⚪︎座面寸法/⚪︎口金/⚪︎梱包サイズ/⚫︎古物の特徴/売却の優先度は
      // CustomFieldDefinition由来 — Inventoryモデルの実カラムではないため
      // item[col.key]ではなくcustomFields[col.key]から読む
      // (exportFields.tsのKNOWN_CUSTOM_FIELD_KEYS参照)。
      raw[col.key] = KNOWN_CUSTOM_FIELD_KEYS.has(col.key) ? (customFields[col.key] ?? "") : ((item as unknown as Record<string, unknown>)[col.key] ?? "");
    }
    for (const col of customFieldColumns) raw[col.key] = customFields[col.key] ?? "";

    const row: Record<string, string | number> = {};
    for (const col of columns) row[col.key] = formatCellValue(raw[col.key], col.valueType);
    return row;
  });

  // ファイル名の日付はJST基準。toISOString()はUTCなので、Amplifyの実行
  // 環境(UTC)で朝9時より前に出力すると前日の名前が付いてしまい、
  // 「今日出したファイル」が昨日の日付で保存される。日次の在庫表を
  // 日付で並べて管理する使い方では実害があるため、表示日付をJSTへ
  // 固定した他の箇所(lib/inventory/formatJst.ts)と揃える。
  const jst = nowInJst();
  const timestamp = `${jst.year}${String(jst.month).padStart(2, "0")}${String(jst.day).padStart(2, "0")}`;
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

/** Fixed selection: never fall back to a full scan if an ID has disappeared. */
async function fetchSelectedForExport(ids:readonly string[]):Promise<InventoryModel[]> {
 if(!ids.length||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>128))throw Error('選択した商品を確認してください。');
 const found=await readInventoryBatch(inventoryDdb,inventoryTable('Inventory'),ids);
 return ids.map(id=>{const row=found.get(id);if(!row||row.deletedAt||row.mergedIntoId||row.listingPartition==='MERGED')throw Error('選択した商品の一部が削除・統合されています。選び直してください。');return row as unknown as InventoryModel;});
}
