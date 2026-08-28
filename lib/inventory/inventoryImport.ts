import "server-only";
import ExcelJS from "exceljs";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { listAllMasterEntries, normalizeMasterName } from "./masters";
import { listCustomFieldDefinitions, listStatuses } from "./queries";
import { parseCustomFields, stringifyCustomFields } from "./customFieldsCodec";
import { diffField, logInventoryHistory, type HistoryFieldChange } from "./history";
import { CORE_EXPORT_FIELDS, EXTENDED_EXPORT_FIELDS, SKU_FIELD, type ExportFieldValueType } from "./exportFields";
import { parseCsv } from "./csv";

type InventoryModel = Schema["Inventory"]["type"];

/**
 * 在庫データのインポート (統合改善指示書 §12-§19)。ZAICO API同期
 * (lib/inventory/zaicoSync.ts / lib/inventory/zaicoMapping.ts) とは
 * 完全に独立した経路 — コードの再利用・import一切なし(spec §19:
 * 「ZAICO → BELLO API同期とCSV/Excelインポートは別経路として整理し
 * てください」)。数値/日付パーサ等、見た目の似た小さなロジックが多少
 * 重複しているのは意図的。
 *
 * 3段階に分かれる:
 * 1. parseImportFile — アップロードされたCSV/Excelを行配列へ変換し、
 *    見出し文字列からBELLO項目への対応候補を提案するだけ。DBには一切
 *    アクセスしない。
 * 2. resolveImportRows — マッピング確定後、既存在庫(SKU一致)・
 *    カテゴリ/保管場所名の解決・型変換・新規/更新/変更なし/エラーの
 *    判定を行う。ここもDBは読むだけで一切書き込まない
 *    (プレビュー・実行の両方から呼ばれる — spec §16「最終確認前にDBを
 *    書き換えない」を、実行の直前まで同じ関数を使うことで自然に守る)。
 * 3. executeImportRows — 実際にInventory.create/updateを呼び、
 *    InventoryHistoryへ記録する。1件ずつ順番に処理し、他の行の成功/
 *    失敗に関わらず独立して結果を返す。
 */

// ────────────────────────────────────────────────────────────────────
// 1. ファイル解析
// ────────────────────────────────────────────────────────────────────

export interface ParsedImportFile {
  headers: string[];
  rows: Record<string, string>[]; // keyed by the file's own header text
  /** header → 提案されたBELLO項目key（"sku"含む）。一致しなければnull。 */
  suggestedMapping: Record<string, string | null>;
  /** マッピングUIが選択肢として提示する対応先の全リスト（"sku"含む・CustomFieldDefinition分含む） — クライアント側は静的なexportFields.tsに加えて動的なcustom fieldsも知る必要があるため、ここでまとめて返す。 */
  mappingTargets: { key: string; label: string }[];
}

/** 安全弁 — 想定規模(数百〜数千件)を大きく超えるファイルは、ブラウザ/Server Actionを詰まらせる前に断る(spec §18)。将来的にもっと大きな規模が必要になった場合は、chunk/バックグラウンド処理への切り替えが必要になる旨を完了報告で明記する。 */
export const IMPORT_MAX_ROWS = 5000;

/** エクスポート側のラベルと1:1で対応させる(spec §14: BELLO自身の出力をそのまま再インポートしやすく)。SKUも候補に含める — 書き込み対象ではなく照合キーとして選べるようにするため(inventoryImport.tsの他の箇所を参照)。 */
const MAPPING_TARGETS: { key: string; label: string; valueType: ExportFieldValueType }[] = [
  SKU_FIELD,
  ...CORE_EXPORT_FIELDS,
  ...EXTENDED_EXPORT_FIELDS,
];

function buildSuggestedMapping(headers: string[], mappingTargets: { key: string; label: string }[]): Record<string, string | null> {
  const byLabel = new Map<string, string>();
  for (const t of mappingTargets) byLabel.set(normalizeMasterName(t.label), t.key);

  const mapping: Record<string, string | null> = {};
  for (const header of headers) {
    mapping[header] = byLabel.get(normalizeMasterName(header)) ?? null;
  }
  return mapping;
}

function parseCsvFile(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { headers: [], rows: [] };
  const headers = table[0].map((h) => h.trim());
  const rows = table.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
  return { headers, rows };
}

async function parseXlsxFile(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return;
      const cell = row.getCell(i + 1);
      let value = cell.value;
      // 日付セルはExcel上でDateオブジェクトとして保持される — 文字列
      // 化はCSVと同じ"YYYY/MM/DD"へ揃える(以降のparseImportDateは
      // "YYYY/MM/DD"と"YYYY-MM-DD"の両方を受け付ける)。
      if (value instanceof Date) {
        const pad = (n: number) => String(n).padStart(2, "0");
        value = `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())}`;
      }
      const str = value === null || value === undefined ? "" : String(value).trim();
      if (str) hasValue = true;
      record[header] = str;
    });
    if (hasValue) rows.push(record);
  }
  return { headers, rows };
}

export async function parseImportFile(filename: string, bytes: ArrayBuffer): Promise<ParsedImportFile> {
  const isXlsx = /\.xlsx$/i.test(filename);
  const { headers, rows } = isXlsx ? await parseXlsxFile(bytes) : parseCsvFile(new TextDecoder("utf-8").decode(bytes));

  if (rows.length > IMPORT_MAX_ROWS) {
    throw new Error(`1回のインポートは最大${IMPORT_MAX_ROWS}件までです（${rows.length}件検出）。ファイルを分割してください。`);
  }
  if (headers.length === 0) {
    throw new Error("ヘッダー行が見つかりませんでした。1行目に列名（BELLOのエクスポート形式であれば「商品名」「SKU」等）を入れてください。");
  }

  const customFieldDefs = await listCustomFieldDefinitions();
  const mappingTargets = [
    ...MAPPING_TARGETS.map((t) => ({ key: t.key, label: t.label })),
    ...customFieldDefs.map((def) => ({ key: def.fieldKey, label: def.label })),
  ];

  return { headers, rows, suggestedMapping: buildSuggestedMapping(headers, mappingTargets), mappingTargets };
}

// ────────────────────────────────────────────────────────────────────
// 2. 行の解決（新規/更新/変更なし/エラーの判定） — DBは読むだけ
// ────────────────────────────────────────────────────────────────────

export interface ImportRowOutcome {
  /** ファイル上の実際の行番号（見出し=1行目として数える、エラーメッセージが「18行目」のように現物のファイルと対応するように）。 */
  rowNumber: number;
  name: string;
  status: "create" | "update" | "unchanged" | "error";
  inventoryId?: string;
  warnings: string[];
  error?: string;
  /** create/updateのときだけ — 実際にInventory.create/updateへ渡す値。executeImportRowsが使う。 */
  writePayload?: Record<string, string | number | null>;
  /** update/createのときだけ — InventoryHistoryへ書く差分。executeImportRowsが使う。 */
  historyChanges?: HistoryFieldChange[];
}

/** "22,800" "¥22800" 等 → 数値。変換できなければ警告のみ、行全体は失敗させない。 */
function parseImportNumber(raw: string, label: string, warnings: string[]): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[,円¥]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    warnings.push(`「${label}」の値 "${raw}" を数値に変換できませんでした（この項目は更新されません）。`);
    return null;
  }
  return n;
}

/** "2026/08/27" "2026-08-27" → AWSDate "2026-08-27"。 */
function parseImportDate(raw: string, label: string, warnings: string[]): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!m) {
    warnings.push(`「${label}」の値 "${raw}" を日付に変換できませんでした（この項目は更新されません）。`);
    return null;
  }
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

interface FieldMeta {
  valueType: ExportFieldValueType;
  label: string;
}

async function buildFieldMetaMap(): Promise<Record<string, FieldMeta>> {
  const customFieldDefs = await listCustomFieldDefinitions();
  const map: Record<string, FieldMeta> = {};
  for (const f of CORE_EXPORT_FIELDS) map[f.key] = { valueType: f.valueType, label: f.label };
  for (const f of EXTENDED_EXPORT_FIELDS) map[f.key] = { valueType: f.valueType, label: f.label };
  for (const def of customFieldDefs) map[def.fieldKey] = { valueType: def.fieldType === "NUMBER" ? "number" : "string", label: def.label };
  return map;
}

/**
 * `mapping`: ファイルの見出し文字列 → BELLO項目key（"sku"含む、
 * parseImportFile.suggestedMappingをユーザーが確認・調整したもの）。
 * ここで書き込み先DBには一切触れない — 読み取り専用のprefetch
 * (既存Inventory・Category・Location・StatusMaster・CustomFieldDefinition)
 * だけで全行を解決する。
 */
export async function resolveImportRows(
  rawRows: Record<string, string>[],
  mapping: Record<string, string>,
): Promise<ImportRowOutcome[]> {
  const [categories, locations, statuses, fieldMeta] = await Promise.all([
    listAllMasterEntries("Category"),
    listAllMasterEntries("Location"),
    listStatuses(),
    buildFieldMetaMap(),
  ]);
  const categoryByName = new Map(categories.map((c) => [normalizeMasterName(c.name), c]));
  const locationByName = new Map(locations.map((l) => [normalizeMasterName(l.name), l]));
  const statusByLabel = new Map(statuses.map((s) => [normalizeMasterName(s.label), s]));

  // 既存Inventoryを1回だけ全件走査してSKU→レコードのMapを作る — 行ごと
  // にDB問い合わせしない(spec §18、lib/inventory/zaicoSync.tsの
  // fetchAllZaicoManagedInventoryと同じ形のprefetch)。
  const existingBySku = new Map<string, InventoryModel>();
  {
    let nextToken: string | null | undefined;
    do {
      const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.list({
        filter: { deletedAt: { attributeExists: false } },
        limit: 200,
        nextToken: nextToken ?? undefined,
        ...inventoryAuthMode,
      });
      if (errors) throw new Error(`既存在庫の取得に失敗しました: ${JSON.stringify(errors)}`);
      for (const item of data) existingBySku.set(item.sku, item);
      nextToken = nt;
    } while (nextToken);
  }

  const skuHeader = Object.entries(mapping).find(([, target]) => target === "sku")?.[0];
  const fieldEntries = Object.entries(mapping).filter(([, target]) => target && target !== "sku") as [string, string][];

  return rawRows.map((row, i): ImportRowOutcome => {
    const rowNumber = i + 2; // +1 for 1-based, +1 for the header row itself
    const warnings: string[] = [];
    const skuValue = skuHeader ? row[skuHeader]?.trim() : "";
    const existing = skuValue ? existingBySku.get(skuValue) : undefined;
    if (skuValue && !existing) {
      warnings.push(`指定されたSKU "${skuValue}" は既存の在庫と一致しないため、新規登録として扱います（SKUは自動採番されます）。`);
    }

    const payload: Record<string, string | number | null> = {};
    let name = existing?.name ?? "";
    let rowError: string | null = null;

    for (const [header, targetKey] of fieldEntries) {
      const raw = row[header] ?? "";

      if (targetKey === "name") {
        const trimmed = raw.trim();
        if (!trimmed && !existing) {
          rowError = "商品名が空です。";
        } else if (trimmed) {
          name = trimmed;
          payload.name = trimmed;
        }
        continue;
      }
      if (targetKey === "categoryName") {
        const trimmed = raw.trim();
        if (!trimmed) {
          payload.categoryId = null;
          continue;
        }
        const match = categoryByName.get(normalizeMasterName(trimmed));
        if (!match) {
          rowError = `カテゴリ "${trimmed}" が見つかりません。/inventory/settingsで作成してから再度お試しください。`;
          continue;
        }
        payload.categoryId = match.id;
        continue;
      }
      if (targetKey === "locationName") {
        const trimmed = raw.trim();
        if (!trimmed) {
          payload.locationId = null;
          continue;
        }
        const match = locationByName.get(normalizeMasterName(trimmed));
        if (!match) {
          rowError = `保管場所 "${trimmed}" が見つかりません。/inventory/settingsで作成してから再度お試しください。`;
          continue;
        }
        payload.locationId = match.id;
        continue;
      }
      if (targetKey === "statusLabel") {
        const trimmed = raw.trim();
        if (!trimmed) continue; // 状態は必須ではないので、未指定なら触れない
        const match = statusByLabel.get(normalizeMasterName(trimmed));
        if (!match) {
          warnings.push(`状態 "${trimmed}" が見つからないため、状態は更新されません。`);
          continue;
        }
        payload.statusId = match.id;
        continue;
      }

      const meta = fieldMeta[targetKey];
      if (!meta) continue; // マッピング候補にない未知のtarget key(理論上到達しない)
      if (meta.valueType === "number") {
        const n = parseImportNumber(raw, meta.label, warnings);
        if (raw.trim() === "") payload[targetKey] = null;
        else if (n !== null) payload[targetKey] = n;
      } else if (meta.valueType === "date") {
        const d = parseImportDate(raw, meta.label, warnings);
        if (raw.trim() === "") payload[targetKey] = null;
        else if (d !== null) payload[targetKey] = d;
      } else {
        payload[targetKey] = raw.trim() || null;
      }
    }

    // 「商品名」列が一切マッピングされていない場合(fieldEntriesに
    // "name"が現れず、上のループでは検出できない)も、新規登録では商
    // 品名が必須であることに変わりはない — ループの外でもう一度確認
    // する。既存更新の場合は商品名列が無くても既存の名前をそのまま使
    // えるため対象外。
    if (!rowError && !existing && !name.trim()) {
      rowError = "商品名が空です（「商品名」列をBELLO項目にマッピングしてください）。";
    }

    if (rowError) {
      return { rowNumber, name: name || "(商品名未設定)", status: "error", warnings, error: rowError };
    }

    if (!existing) {
      return { rowNumber, name, status: "create", warnings, writePayload: payload };
    }

    // 更新候補 — 実際に値が変わる項目だけをdiffし、1つも変わらなければ
    // "unchanged"としてスキップする(spec §12-2の「スキップ」)。
    const historyChanges: HistoryFieldChange[] = [];
    const push = (c: HistoryFieldChange | null) => c && historyChanges.push(c);
    for (const [key, value] of Object.entries(payload)) {
      const before = readInventoryField(existing, key);
      const label = fieldLabelFor(key, fieldMeta);
      push(diffField(label, before, value));
    }

    if (historyChanges.length === 0) {
      return { rowNumber, name, status: "unchanged", inventoryId: existing.id, warnings };
    }
    return { rowNumber, name, status: "update", inventoryId: existing.id, warnings, writePayload: payload, historyChanges };
  });
}

function readInventoryField(item: InventoryModel, key: string): string | number | null {
  if (key === "categoryId") return item.categoryId ?? null;
  if (key === "locationId") return item.locationId ?? null;
  if (key === "statusId") return item.statusId ?? null;
  if (key in item) return (item as unknown as Record<string, string | number | null | undefined>)[key] ?? null;
  // custom field
  const customFields = parseCustomFields(item.customFields) ?? {};
  const v = customFields[key];
  return typeof v === "number" || typeof v === "string" ? v : null;
}

function fieldLabelFor(key: string, fieldMeta: Record<string, FieldMeta>): string {
  if (key === "categoryId") return "カテゴリ";
  if (key === "locationId") return "保管場所";
  if (key === "statusId") return "状態";
  return fieldMeta[key]?.label ?? key;
}

export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: { rowNumber: number; name: string; message: string }[];
}

export function summarizeImportOutcomes(outcomes: ImportRowOutcome[]): ImportSummary {
  return {
    total: outcomes.length,
    created: outcomes.filter((o) => o.status === "create").length,
    updated: outcomes.filter((o) => o.status === "update").length,
    unchanged: outcomes.filter((o) => o.status === "unchanged").length,
    errors: outcomes.filter((o) => o.status === "error").map((o) => ({ rowNumber: o.rowNumber, name: o.name, message: o.error ?? "" })),
  };
}

// ────────────────────────────────────────────────────────────────────
// 3. 実行 — 実際にDBへ書き込む
// ────────────────────────────────────────────────────────────────────

export interface ImportExecuteResult extends ImportSummary {
  historyLabel: string;
}

/**
 * outcomesは呼び出し側(app/actions/inventoryImport.ts)がresolveImportRows
 * を(実行直前に再度)呼んで得たもの — create/updateだけ実際に書き込み、
 * unchanged/errorは何もしない。1件ずつ順番に処理し、他の行の成功/失敗
 * に関わらず独立して結果を返す(spec §16「不正データで全処理が壊れな
 * い」)。
 */
export async function executeImportRows(
  outcomes: ImportRowOutcome[],
  who: string | null,
  sourceLabel: "CSVインポート" | "Excelインポート",
): Promise<ImportExecuteResult> {
  const results: ImportRowOutcome[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "unchanged" || outcome.status === "error") {
      results.push(outcome);
      continue;
    }
    try {
      if (outcome.status === "create") {
        const { data: sku, errors: skuErrors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
        if (skuErrors || !sku) throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(skuErrors)}`);

        const { customFields, ...corePayload } = splitCustomFields(outcome.writePayload ?? {});
        const { data: created, errors } = await serverDataClient.models.Inventory.create(
          { sku, name: outcome.name, ...corePayload, customFields: stringifyCustomFields(customFields), createdBy: who ?? undefined, updatedBy: who ?? undefined },
          inventoryAuthMode,
        );
        if (errors || !created) throw new Error(`作成に失敗しました: ${JSON.stringify(errors)}`);

        await logInventoryHistory(created.id, who, [{ fieldName: "登録", oldValue: null, newValue: `${sourceLabel}により新規登録 (SKU ${sku})` }]);
        results.push({ ...outcome, inventoryId: created.id });
      } else if (outcome.status === "update" && outcome.inventoryId) {
        const { data: existing } = await serverDataClient.models.Inventory.get({ id: outcome.inventoryId }, inventoryAuthMode);
        if (!existing || existing.deletedAt) throw new Error("対象の在庫が見つかりません（削除された可能性があります）。");

        const { customFields, ...corePayload } = splitCustomFields(outcome.writePayload ?? {});
        const mergedCustomFields = Object.keys(customFields).length > 0 ? { ...(parseCustomFields(existing.customFields) ?? {}), ...customFields } : undefined;

        const { errors } = await serverDataClient.models.Inventory.update(
          {
            id: outcome.inventoryId,
            ...corePayload,
            ...(mergedCustomFields ? { customFields: stringifyCustomFields(mergedCustomFields) } : {}),
            updatedBy: who ?? undefined,
          },
          inventoryAuthMode,
        );
        if (errors) throw new Error(`更新に失敗しました: ${JSON.stringify(errors)}`);

        await logInventoryHistory(
          outcome.inventoryId,
          who,
          (outcome.historyChanges ?? []).map((c) => ({ ...c, fieldName: `${c.fieldName}（${sourceLabel}）` })),
        );
        results.push(outcome);
      } else {
        results.push(outcome);
      }
    } catch (err) {
      results.push({ ...outcome, status: "error", error: err instanceof Error ? err.message : "処理に失敗しました。" });
    }
  }

  const summary = summarizeImportOutcomes(results);
  return { ...summary, historyLabel: sourceLabel };
}

const KNOWN_CORE_KEYS = new Set([
  "name",
  "categoryId",
  "locationId",
  "statusId",
  "quantity",
  "unit",
  "purchasePrice",
  "salePrice",
  "barcode",
  "note",
  ...EXTENDED_EXPORT_FIELDS.map((f) => f.key),
]);

/** payload内の「Inventoryの実カラムに直接書ける値」と「customFieldsに入れるべき値(管理者定義フィールド)」を分ける。 */
function splitCustomFields(payload: Record<string, string | number | null>): {
  customFields: Record<string, string | number | null>;
  [key: string]: unknown;
} {
  const core: Record<string, string | number | null> = {};
  const customFields: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_CORE_KEYS.has(key)) core[key] = value;
    else customFields[key] = value;
  }
  return { ...core, customFields };
}
