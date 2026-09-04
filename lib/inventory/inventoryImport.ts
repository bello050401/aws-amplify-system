import "server-only";
import ExcelJS from "exceljs";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { clearInventoryCountCache } from "./inventoryCountCache";
import type { Schema } from "@/amplify/data/resource";
import { listAllMasterEntries, normalizeMasterName } from "./masters";
import { listCustomFieldDefinitions, listStatuses } from "./queries";
import { parseCustomFields, stringifyCustomFields } from "./customFieldsCodec";
import { diffField, logInventoryHistory, type HistoryFieldChange } from "./history";
import { STATIC_EXPORT_FIELDS, EXTENDED_EXPORT_FIELDS, KNOWN_CUSTOM_FIELD_KEYS, type ExportFieldValueType } from "./exportFields";
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
  /** header → その列に実データがある行が1件でもあるか。「自動対応済み/確認が必要/対応なし」のUI上の分類(夜間開発指示書 §8)に使う — 空欄しかない列は対応なしのまま無視して問題ない可能性が高いことを示す目安。 */
  columnHasData: Record<string, boolean>;
}

/** 安全弁 — 想定規模(数百〜数千件)を大きく超えるファイルは、ブラウザ/Server Actionを詰まらせる前に断る(spec §18)。将来的にもっと大きな規模が必要になった場合は、chunk/バックグラウンド処理への切り替えが必要になる旨を完了報告で明記する。 */
export const IMPORT_MAX_ROWS = 5000;

/**
 * エクスポート側の列（ZAICO互換ブロック→BELLO独自列の順、
 * exportFields.tsのSTATIC_EXPORT_FIELDS）と1:1で対応させる(spec §14:
 * BELLO自身の出力をそのまま再インポートしやすく)。「在庫ID」
 * (displayId)・SKUも候補に含める — どちらも書き込み対象ではなく
 * 既存レコードの照合キーとして選べるようにするため
 * (resolveImportRows内のfindExistingMatchを参照、spec §7の
 * 「1.ZAICO在庫ID/sourceInventoryId → 2.BELLO在庫ID →
 * 3.SKU」優先順位はここで実装する)。
 */
const MAPPING_TARGETS: { key: string; label: string; valueType: ExportFieldValueType }[] = STATIC_EXPORT_FIELDS;

/**
 * ヘッダー文字列の自動対応付け専用の正規化。lib/inventory/masters.ts の
 * normalizeMasterName(NFKC+trim+空白畳み込み+小文字化)はCategory/
 * Location名の一致判定など他の用途にも使われているためそのままにし、
 * ここではインポートのヘッダー対応付けだけに使うローカルな追加正規化
 * (variation selector除去・波ダッシュ統一)を重ねる —
 * lib/inventory/zaicoMapping.tsのnormalizeZaicoAttributeNameと着想は
 * 同じだが、完全に独立した実装(import一切なし。ZAICO同期とCSV/Excel
 * インポートは別経路、コード共有しないというspec §19の方針を維持)。
 * ZAICO_COMPAT_FIELDSの列名(⚪︎/⚫︎等の記号を含む)を実際のZAICO
 * エクスポートファイルのヘッダーと確実に対応付けるための備え。
 */
export function normalizeImportHeaderLabel(text: string): string {
  return normalizeMasterName(
    text
      .normalize("NFKC")
      .replace(/[︀-️]/g, "") // variation selectors U+FE00–U+FE0F
      .replace(/[〜～]/g, "~"),
  );
}

/**
 * 列名の先頭についた装飾記号(ZAICOのエクスポート列名によく現れる
 * ⚪/⚫/○/●/◎/◉/☆/★/□/■/・等)を取り除く — spec §8の例示そのまま。
 * "先頭"だけを対象にする(文字列中間・末尾は触らない)ことで、
 * "<<出品情報>>"のような意味のある記号や、たまたま本文中に同じ文字を
 * 含む値を無条件に壊さないようにしている。ZAICO_COMPAT_FIELDSの正式
 * ラベル自体はこの記号を含めたままexactマッチする(normalizeImportHeaderLabel
 * のみ)ので、この関数は「記号の有無・種類が実際のファイルによって揺れ
 * ている」場合のフォールバック専用(buildSuggestedMappingの後段でのみ
 * 使う)。
 */
export function stripLeadingDecoration(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/^[⚪⚫○●◎◉☆★□■・\s]+/u, "")
    .trim();
}

/**
 * BELLO/ZAICOでよく使われる別名(spec §8)。正式なマッピング対象ラベル
 * (mappingTargets)とは表記が異なるが意味は一意に定まる、人手で確認済
 * みの組だけを列挙する — あいまい一致(編集距離・部分一致等)は一切行
 * わない。特に在庫ID/SKU/価格/カテゴリ/保管場所/日付/古物台帳のような
 * 誤認識のリスクが高い項目は、ここに無い限り自動確定しない
 * (buildSuggestedMappingの4段目「不明」へ回り、ユーザー確認が必要にな
 * る)。
 */
const IMPORT_HEADER_ALIASES: { alias: string; key: string }[] = [
  { alias: "商品名", key: "name" }, // ZAICOの正式列名は「物品名」
  { alias: "バーコード", key: "barcode" }, // ZAICOの正式列名は「QRコード・バーコードの値」
  { alias: "仕入原価", key: "purchasePrice" }, // 一覧列の表記(ZAICOの正式列名は「⚫︎購入価格」)
  { alias: "仕入単価", key: "purchasePrice" },
  { alias: "販売価格（成約）", key: "salePrice" }, // 一覧列の表記(ZAICOの正式列名は「⚫︎販売価格」)
  { alias: "カテゴリー", key: "categoryName" }, // 長音有無の表記ゆれ
  { alias: "ステータス", key: "statusLabel" },
];

/**
 * ヘッダー→BELLO項目の自動対応付け(spec §8の優先順位):
 * 1. 完全一致 / 2. normalizeHeader後完全一致 — この2つはどちらも
 *    normalizeImportHeaderLabelで両辺を正規化してから比較するため、
 *    実質1回のMap検索で両方を兼ねる(生の完全一致は正規化後も完全一致
 *    のまま、normalizeが結果を変えることはない)。
 * 3. 明示alias(IMPORT_HEADER_ALIASES) — 上記で一致しなかった場合のみ。
 * 4. 先頭の装飾記号を外した上での再挑戦(フォールバック) — ZAICOの実
 *    エクスポートで記号の有無・種類が揺れているケースを拾う。
 * これでも一致しなければnull — フリー本推測(fuzzy matching)は一切行
 * わず、ユーザー確認へ回す(spec: 「勝手に確定しない」)。
 */
/**
 * その対応先へ実際に書き込んでよいかどうか。
 *
 * 書き込まないもの:
 *  - "displayId" / "sku" … 既存レコードの照合キー専用
 *  - exportFields.tsで `importable: false` を付けた列
 *    (「更新日」「作成日」「棚卸日」など、BELLO側が管理する値)
 *
 * この判定が無かったころは、`importable` フラグがどこからも参照されず、
 * 「更新日」まで書き込み対象に入っていた。その結果、エクスポートした
 * CSVを1文字も編集せずに取り込んでも必ず「更新」と判定され、触っていない
 * 行まで毎回書き換わっていた(実測 — 56列を二分探索して原因列を特定)。
 */
export function isWritableImportTarget(target: string): boolean {
  if (target === "sku" || target === "displayId") return false;
  const field = STATIC_EXPORT_FIELDS.find((f) => f.key === target);
  // 見つからないkeyはCustomFieldDefinition由来の追加項目 — こちらは書き込む。
  return field ? field.importable : true;
}

export function buildSuggestedMapping(headers: string[], mappingTargets: { key: string; label: string }[]): Record<string, string | null> {
  const targetKeys = new Set(mappingTargets.map((t) => t.key));

  const byLabel = new Map<string, string>();
  for (const t of mappingTargets) {
    const norm = normalizeImportHeaderLabel(t.label);
    if (!byLabel.has(norm)) byLabel.set(norm, t.key);
  }

  const byAlias = new Map<string, string>();
  for (const { alias, key } of IMPORT_HEADER_ALIASES) {
    if (!targetKeys.has(key)) continue; // マッピング候補に無いkey(理論上到達しない)は登録しない
    const norm = normalizeImportHeaderLabel(alias);
    if (!byAlias.has(norm)) byAlias.set(norm, key);
  }

  const byStrippedLabel = new Map<string, string>();
  for (const t of mappingTargets) {
    const stripped = normalizeImportHeaderLabel(stripLeadingDecoration(t.label));
    if (stripped && !byStrippedLabel.has(stripped)) byStrippedLabel.set(stripped, t.key);
  }

  const mapping: Record<string, string | null> = {};
  for (const header of headers) {
    const normalized = normalizeImportHeaderLabel(header);
    const strippedNormalized = normalizeImportHeaderLabel(stripLeadingDecoration(header));
    mapping[header] = byLabel.get(normalized) ?? byAlias.get(normalized) ?? byStrippedLabel.get(strippedNormalized) ?? byLabel.get(strippedNormalized) ?? null;
  }
  return mapping;
}

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §5.2: CSVの文字コードをUTF-8決め打ちに
 * しない。Excelの「CSV(コンマ区切り)」形式での保存はWindows既定で
 * Shift_JIS(CP932)になることが多く、以前の実装
 * (`new TextDecoder("utf-8").decode(bytes)`)はTextDecoderの既定動作
 * (不正なUTF-8バイト列を例外無しでU+FFFDへ置換する)により、
 * Shift_JISファイルを読んでも例外を出さずに文字化けした内容を
 * そのまま返していた——エラーにすらならず、ユーザーが気づかないまま
 * 全列が誤対応/文字化けするという、クラッシュより発見しにくい不具合
 * だった。
 *
 * 修正: まずUTF-8を`fatal: true`で試し(不正なバイト列があれば例外を
 * 投げさせる——実際にNode.jsのTextDecoderでこの検知が機能することを
 * 確認済み)、失敗したらShift_JISとして再デコードする。UTF-8 BOM
 * (Excelの「UTF-8 CSV」形式が付与する)は事前に取り除く。
 */
export function decodeImportText(bytes: ArrayBuffer): string {
  const withoutBom = (() => {
    const view = new Uint8Array(bytes);
    if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
      return view.slice(3).buffer;
    }
    return bytes;
  })();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
  } catch {
    // UTF-8として不正 — Excel(Windows既定)のShift_JIS(CP932)保存を想定してフォールバックする。
    return new TextDecoder("shift_jis").decode(withoutBom);
  }
}

export function parseCsvFile(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { headers: [], rows: [] };
  const headers = table[0].map((h) => h.trim());
  const rows = table.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
  return { headers, rows };
}

export async function parseXlsxFile(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    // 不具合修正指示書§5.5: 壊れたxlsx/CSVを装った別形式等を、原因不明の
    // 例外のまま上へ伝播させない——ここで検知して安全なメッセージへ
    // 変換する(P0-1で確立した「throwする場合もユーザーに理解可能な
    // メッセージにする」方針、実際にexceljsが投げる例外を実機確認して
    // 追加した分岐)。
    console.error("[parseXlsxFile] workbook.xlsx.load failed:", err instanceof Error ? err.message : err);
    throw new Error("ファイルが破損しているか、正しいExcel形式(.xlsx)ではありません。別のファイルを確認してください。");
  }
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
  // 不具合修正指示書§5.5: 0バイトファイルを、ExcelJS/CSVパーサの原因
  // 不明な例外(または「ヘッダー行が見つかりません」という誤解を招く
  // メッセージ)に委ねず、ここで明確に検知する。
  if (bytes.byteLength === 0) {
    throw new Error("ファイルが空です。内容のあるCSVまたはExcelファイルを選択してください。");
  }
  const isXlsx = /\.xlsx$/i.test(filename);
  const { headers, rows } = isXlsx ? await parseXlsxFile(bytes) : parseCsvFile(decodeImportText(bytes));

  if (rows.length > IMPORT_MAX_ROWS) {
    throw new Error(`1回のインポートは最大${IMPORT_MAX_ROWS}件までです（${rows.length}件検出）。ファイルを分割してください。`);
  }
  if (headers.length === 0) {
    throw new Error("ヘッダー行が見つかりませんでした。1行目に列名（BELLOのエクスポート形式であれば「商品名」「SKU」等）を入れてください。");
  }

  const customFieldDefs = await listCustomFieldDefinitions();
  // KNOWN_CUSTOM_FIELD_KEYS(脚高/座面寸法/口金/梱包サイズ/古物の特徴/
  // 売却の優先度)はすでにMAPPING_TARGETS(STATIC_EXPORT_FIELDS)側に
  // ZAICO互換ラベルで含まれている — ここでもう一度足すと同じ項目が
  // 選択肢に重複表示されてしまうため除外する。管理者が今後追加した、
  // それ以外のcustom fieldだけをここで末尾に足す。
  const dynamicCustomFieldDefs = customFieldDefs.filter((def) => !KNOWN_CUSTOM_FIELD_KEYS.has(def.fieldKey));
  const mappingTargets = [
    ...MAPPING_TARGETS.map((t) => ({ key: t.key, label: t.label })),
    ...dynamicCustomFieldDefs.map((def) => ({ key: def.fieldKey, label: def.label })),
  ];

  // 「自動対応済み/確認が必要/対応なし」のUI表示用(spec §8) — 対応先が
  // 見つからなかった列でも、実際に値が入っている行が1件でもあれば
  // 「確認が必要」、全行空欄なら「対応なし」寄りとしてUI側が案内する。
  const columnHasData: Record<string, boolean> = {};
  for (const header of headers) {
    columnHasData[header] = rows.some((row) => (row[header] ?? "").trim() !== "");
  }

  return { headers, rows, suggestedMapping: buildSuggestedMapping(headers, mappingTargets), mappingTargets, columnHasData };
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
export function parseImportNumber(raw: string, label: string, warnings: string[]): number | null {
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
export function parseImportDate(raw: string, label: string, warnings: string[]): string | null {
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
  for (const f of STATIC_EXPORT_FIELDS) map[f.key] = { valueType: f.valueType, label: f.label };
  // extendedFields.ts側のBELLO UI寄りのラベル(例:「コンディション評価」)
  // で上書きする — 警告文はZAICO互換の記号付きラベルより読みやすい方を
  // 優先する(exportFields.tsの冒頭コメント参照。keyは共通、labelだけ
  // 用途によって意図的に別々)。
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

  // 既存Inventoryを1回だけ全件走査して、sourceInventoryId(ZAICO在庫ID)
  // →レコードのMapと、SKU→レコードのMapを両方作る — 行ごとにDB問い合わせ
  // しない(spec §18、lib/inventory/zaicoSync.tsのfetchAllZaicoManagedInventory
  // と同じ形のprefetch)。spec §7の優先順位(1.ZAICO在庫ID/sourceInventoryId
  // → 2.BELLO在庫ID → 3.SKU)をfindExistingMatchで実装するための下準備。
  const existingBySku = new Map<string, InventoryModel>();
  const existingBySourceId = new Map<string, InventoryModel>();
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
      for (const item of data) {
        existingBySku.set(item.sku, item);
        if (item.sourceSystem === "ZAICO" && item.sourceInventoryId) existingBySourceId.set(item.sourceInventoryId, item);
      }
      nextToken = nt;
    } while (nextToken);
  }

  // 「在庫ID」(displayId)列とSKU列は書き込み対象ではなく、既存レコード
  // の照合キー専用 — 一般のfieldEntriesループには含めない。
  const displayIdHeader = Object.entries(mapping).find(([, target]) => target === "displayId")?.[0];
  const skuHeader = Object.entries(mapping).find(([, target]) => target === "sku")?.[0];
  // 「更新日」「作成日」「棚卸日」のようにBELLOが書き換えてはいけない列も
  // 同様に除外する。exportFields.tsは以前からこれらへ importable: false を
  // 付けていたが、その値がどこでも参照されておらず、書き込み対象へ素通り
  // していた。
  //
  // 実害: エクスポートしたCSVを1文字も編集せずにそのまま取り込むと、
  // プレビューが「スキップ(変更なし)」ではなく必ず「更新」になる
  // (実測 — 56列を二分探索して原因列が「更新日」だと確認した)。
  // ユーザーの通常の使い方は「エクスポート → Excelで一部だけ直す →
  // 取り込む」なので、触っていない行まで毎回更新扱いになり、更新履歴が
  // 実際の変更で埋もれる。
  const fieldEntries = Object.entries(mapping).filter(([, target]) => target && isWritableImportTarget(target)) as [string, string][];

  /**
   * spec §7の照合優先順位: 1. ZAICO在庫ID(sourceInventoryId) → 2. BELLO
   * 在庫ID(ZAICO由来でない行は displayId===sku なので実質SKU一致) →
   * 3. 別途マッピングされたSKU列。「在庫ID」列の値は、ZAICO由来行なら
   * sourceInventoryIdの値、BELLO発行行ならSKUの値がそのまま入っている
   * (lib/inventory/inventoryId.tsのresolveDisplayInventoryIdと対称)
   * ため、まずsourceInventoryIdのMapを、次にSKUのMapを順に引く。
   */
  function findExistingMatch(row: Record<string, string>): { existing: InventoryModel | undefined; matchedValue: string } {
    const displayIdValue = displayIdHeader ? (row[displayIdHeader]?.trim() ?? "") : "";
    if (displayIdValue) {
      const bySource = existingBySourceId.get(displayIdValue);
      if (bySource) return { existing: bySource, matchedValue: displayIdValue };
      const bySku = existingBySku.get(displayIdValue);
      if (bySku) return { existing: bySku, matchedValue: displayIdValue };
    }
    const skuValue = skuHeader ? (row[skuHeader]?.trim() ?? "") : "";
    if (skuValue) {
      const bySku = existingBySku.get(skuValue);
      if (bySku) return { existing: bySku, matchedValue: skuValue };
    }
    return { existing: undefined, matchedValue: displayIdValue || skuValue };
  }

  return rawRows.map((row, i): ImportRowOutcome => {
    const rowNumber = i + 2; // +1 for 1-based, +1 for the header row itself
    const warnings: string[] = [];
    const { existing, matchedValue } = findExistingMatch(row);
    if (matchedValue && !existing) {
      warnings.push(`指定された在庫ID/SKU "${matchedValue}" は既存の在庫と一致しないため、新規登録として扱います（SKUは自動採番されます）。`);
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
          {
            sku,
            name: outcome.name,
            ...corePayload,
            customFields: stringifyCustomFields(customFields),
            createdBy: who ?? undefined,
            updatedBy: who ?? undefined,
            // 第六ラウンドP0-5(amplify/data/resource.tsのInventory
            // モデルコメント参照)。
            listingPartition: "ACTIVE",
            listUpdatedAt: new Date().toISOString(),
          },
          inventoryAuthMode,
        );
        if (errors || !created) throw new Error(`作成に失敗しました: ${JSON.stringify(errors)}`);
        // 在庫が1件増えた。総件数のキャッシュを捨てないと、取込直後の
        // 一覧が古い件数を最大60秒表示し続ける(PHASE 6)。
        clearInventoryCountCache();

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
            // 第六ラウンドP0-5: インポートによる実データ更新なので一覧の
            // 並び順を最新化する対象(thumbnailBackfill.tsとは異なる)。
            listUpdatedAt: new Date().toISOString(),
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
