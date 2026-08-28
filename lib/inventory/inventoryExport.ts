import "server-only";
import ExcelJS from "exceljs";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { listCategories, listCustomFieldDefinitions, listLocations, listStatuses, type InventoryListFilters } from "./queries";
import { parseCustomFields } from "./customFieldsCodec";
import { STATIC_EXPORT_FIELDS, KNOWN_CUSTOM_FIELD_KEYS, type ExportFieldDef } from "./exportFields";
import { resolveDisplayInventoryId } from "./inventoryId";
import { evaluateQuery, matchesQuickSearch, type AdvancedSearchQuery, type SearchFieldDef, type SearchableRecord } from "./advancedSearch";
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
  const conditions: Record<string, unknown>[] = [{ deletedAt: { attributeExists: false } }];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });
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

/** 生のInventoryModelをlib/inventory/advancedSearch.tsの判定関数が読める最小限の形へ変換する — フィールド名はInventoryModelとSearchableRecordで一致しているため、customFields(生JSON文字列→パース済みオブジェクト)とdisplayId(導出値)だけ補えばよい。行の組み立て(下のitems.map)には一切使わない、詳細検索の絞り込み専用のアダプタ。 */
function toSearchableRecordFromRaw(item: InventoryModel): SearchableRecord {
  return {
    ...item,
    customFields: parseCustomFields(item.customFields),
    displayId: resolveDisplayInventoryId({ sourceSystem: item.sourceSystem ?? null, sourceInventoryId: item.sourceInventoryId ?? null, sku: item.sku }),
  } as unknown as SearchableRecord;
}

/**
 * `scope`: "filtered" applies `filters` exactly like the list page's own
 * search/絞り込み (絞り込み結果のエクスポート); "all" ignores them
 * entirely (全在庫). Both go through the same fetchAllForExport/row
 * builder — scope is just which filters get passed in.
 *
 * `advanced`(夜間開発指示書のバグ修正): 詳細検索の結果を表示している
 * 間に「現在の検索・絞り込み結果」をエクスポートすると、詳細検索の条
 * 件(q/categoryIds/locationId/statusId経由では表現できないAND/OR・
 * 演算子つきの条件)が無視され、意図しない全件エクスポートになってし
 * まうバグがあった — 詳細検索が有効なときはこちらを渡し、`filters`は
 * 無視してlib/inventory/advancedSearch.tsのevaluateQueryで絞り込む
 * (queries.tsのlistInventoryAdvancedと同じ設計)。
 */
export async function buildInventoryExport(
  format: "csv" | "xlsx",
  filters: InventoryListFilters,
  advanced?: { query: AdvancedSearchQuery; fieldsByKey: Map<string, SearchFieldDef> },
): Promise<InventoryExportResult> {
  const [categories, locations, statuses, customFieldDefs, items] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
    fetchAllForExport(advanced ? {} : filters),
  ]);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const statusesById = new Map(statuses.map((s) => [s.id, s]));

  // 自由文字列検索(q)はcase-insensitiveに、在庫ID/SKU/物品名へ後段で
  // 絞り込む(理由は上のbuildFilterConditionsのコメント参照)。詳細検索
  // が有効な場合はそちらのevaluateQueryだけを使い、q/categoryIds等の
  // 単純フィルタとは重ねない(一覧画面の詳細検索モードと同じ「置き換
  // え」の考え方)。
  const filteredItems = advanced
    ? items.filter((item) => evaluateQuery(toSearchableRecordFromRaw(item), advanced.query, advanced.fieldsByKey))
    : filters.q
      ? items.filter((item) =>
          matchesQuickSearch(
            {
              displayId: resolveDisplayInventoryId({ sourceSystem: item.sourceSystem ?? null, sourceInventoryId: item.sourceInventoryId ?? null, sku: item.sku }),
              sku: item.sku,
              name: item.name,
              customFields: null,
            },
            filters.q!,
          ),
        )
      : items;

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
      // ZAICOにはあるがBELLOでは追跡していない列 — 列自体は互換性のため
      // 出力するが値は常に空欄(exportFields.tsのコメント参照)。
      stocktakeDate: "",
      groupTag: "",
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
