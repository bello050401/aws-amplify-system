/**
 * BELLO統合業務OS ZAICO級高速化・完成保証最大化版 §51/§57: CSV/XLSX
 * importの代表fixtureテスト。第三ラウンド報告は「コードを読んで問題
 * なさそう」で終えていた(過去の「Server Components render error」を
 * 再現する具体的コミットも見つからなかった)——本ラウンドでは実際の
 * ファイル内容(文字コード/空値/数値/日付/不正行/duplicate)を実際に
 * parseCsv/parseCsvFile/parseXlsxFile/buildSuggestedMapping/
 * parseImportNumber/parseImportDateへ通す。
 *
 * AWSアクセスが必要な`resolveImportRows`/`executeImportRows`/
 * `parseImportFile`(内部でlistCustomFieldDefinitionsを呼ぶ)は対象外
 * ——ここでテストするのは「ファイルパース→値変換→列マッピング」の
 * 純粋ロジック部分(AWS非依存で実行できる、importパイプラインの実際の
 * 入口)。
 *
 * Run with: npm run verify:import
 */
import ExcelJS from "exceljs";
import { parseCsv, toCsv } from "@/lib/inventory/csv";
import { parseCsvFile, parseXlsxFile, buildSuggestedMapping, parseImportNumber, parseImportDate, normalizeImportHeaderLabel, stripLeadingDecoration } from "@/lib/inventory/inventoryImport";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

// ── CSV parse: RFC4180 quoting, embedded commas/newlines ──────────────
function testParseCsvQuoting() {
  const csv = 'name,note\n"田中,商店","改行あり\n備考"\n"引用符""あり""",normal';
  const table = parseCsv(csv);
  assertEqual(table.length, 3, "quoting: ヘッダー含め3行");
  assertEqual(table[1], ["田中,商店", "改行あり\n備考"], "quoting: カンマと改行を含むセルを正しく1セルとして読む");
  assertEqual(table[2], ['引用符"あり"', "normal"], "quoting: 二重引用符のエスケープ(\"\")を1個の\"へ復元");
}

function testParseCsvBom() {
  const withBom = "﻿name,sku\n商品A,SKU001";
  const table = parseCsv(withBom);
  assertEqual(table[0], ["name", "sku"], "BOM: 先頭のUTF-8 BOMを剥がしてヘッダーを正しく読む");
}

function testParseCsvRoundTrip() {
  // BELLO自身のexport(toCsv)がimport(parseCsv)で読み戻せることを確認
  // (spec §14「BELLO自身の出力をそのまま再インポートしやすく」の実地検証)。
  const headers = ["商品名", "備考"];
  const rows = [["ソファ,3人掛け", "\"傷あり\"、改行\nメモ"]];
  const csv = toCsv(headers, rows);
  const parsed = parseCsv(csv);
  assertEqual(parsed[0], headers, "round-trip: エクスポートしたヘッダーをそのまま読み戻せる");
  assertEqual(parsed[1], rows[0], "round-trip: カンマ・引用符・改行を含む値もそのまま読み戻せる");
}

// ── parseCsvFile: ヘッダー/行への変換、欠損セルの扱い ───────────────
function testParseCsvFileMissingCells() {
  const csv = "商品名,SKU,数量\n椅子,SKU100,3\n机,SKU101\n";
  const { headers, rows } = parseCsvFile(csv);
  assertEqual(headers, ["商品名", "SKU", "数量"], "parseCsvFile: ヘッダー抽出");
  assertEqual(rows[1], { 商品名: "机", SKU: "SKU101", 数量: "" }, "parseCsvFile: 行の末尾セルが欠けている(不正行)場合は空文字で補完し、行全体を失わない");
}

function testParseCsvFileEmpty() {
  assertEqual(parseCsvFile(""), { headers: [], rows: [] }, "parseCsvFile: 空文字入力はheaders/rows空配列(例外を投げない)");
}

// ── 数値/日付変換: 空値・不正値・単位付き表記 ──────────────────────
function testParseImportNumber() {
  const warnings: string[] = [];
  assertEqual(parseImportNumber("22,800", "販売価格", warnings), 22800, "数値変換: カンマ区切りの金額");
  assertEqual(parseImportNumber("¥22800", "販売価格", warnings), 22800, "数値変換: 円記号付き");
  assertEqual(parseImportNumber("", "販売価格", warnings), null, "数値変換: 空値はnull(警告なし、更新スキップ扱い)");
  assertEqual(warnings.length, 0, "数値変換: ここまで警告は積まれていない");
  assertEqual(parseImportNumber("不明", "販売価格", warnings), null, "数値変換: 数値化できない不正値はnull");
  assertTrue(warnings.length === 1 && warnings[0].includes("不明"), "数値変換: 不正値は警告を1件積む(行全体は失敗させない)");
}

function testParseImportDate() {
  const warnings: string[] = [];
  assertEqual(parseImportDate("2026/08/27", "仕入日", warnings), "2026-08-27", "日付変換: スラッシュ区切り(ZAICOエクスポート形式)");
  assertEqual(parseImportDate("2026-8-7", "仕入日", warnings), "2026-08-07", "日付変換: ハイフン区切り・ゼロ埋め無しでもAWSDate形式へ正規化");
  assertEqual(parseImportDate("", "仕入日", warnings), null, "日付変換: 空値はnull(警告なし)");
  assertEqual(warnings.length, 0, "日付変換: ここまで警告は積まれていない");
  assertEqual(parseImportDate("令和8年8月27日", "仕入日", warnings), null, "日付変換: 和暦等の未対応形式はnull");
  assertTrue(warnings.length === 1, "日付変換: 未対応形式は警告を1件積む(行全体は失敗させない)");
}

// ── ヘッダー自動マッピング: 完全一致/alias/装飾記号 ─────────────────
const TEST_TARGETS = [
  { key: "name", label: "商品名" },
  { key: "sku", label: "SKU" },
  { key: "purchasePrice", label: "⚫︎購入価格" },
  { key: "categoryName", label: "カテゴリ" },
];

function testBuildSuggestedMapping() {
  const mapping = buildSuggestedMapping(["商品名", "SKU", "⚫︎購入価格", "不明な列"], TEST_TARGETS);
  assertEqual(mapping["商品名"], "name", "自動対応: 完全一致");
  assertEqual(mapping["SKU"], "sku", "自動対応: 完全一致(記号なし)");
  assertEqual(mapping["⚫︎購入価格"], "purchasePrice", "自動対応: 装飾記号込みの正式ラベルと完全一致");
  assertEqual(mapping["不明な列"], null, "自動対応: 一致しない列はnull(フリー推測しない)");
}

function testBuildSuggestedMappingAlias() {
  // IMPORT_HEADER_ALIASESの「商品名」(ZAICO正式列名は「物品名」)の逆——
  // ここでは一覧表記の別名からの対応付けを確認する。
  const mapping = buildSuggestedMapping(["仕入単価", "ステータス"], [{ key: "purchasePrice", label: "購入価格" }, { key: "statusLabel", label: "状態" }]);
  assertEqual(mapping["仕入単価"], "purchasePrice", "自動対応: alias経由(仕入単価→purchasePrice)");
  assertEqual(mapping["ステータス"], "statusLabel", "自動対応: alias経由(ステータス→statusLabel)");
}

function testBuildSuggestedMappingDecoration() {
  const mapping = buildSuggestedMapping(["○購入価格"], [{ key: "purchasePrice", label: "⚫︎購入価格" }]);
  assertEqual(mapping["○購入価格"], "purchasePrice", "自動対応: 先頭装飾記号の種類が違っても(⚫︎ vs ○)フォールバックで一致");
}

function testBuildSuggestedMappingDuplicateHeaders() {
  // 同名ヘッダーが複数列ある(実務でありがちな不正/重複ファイル)場合、
  // どちらもマッピング結果が上書きされるだけでクラッシュしないことを
  // 確認する(mappingはheaderをkeyとするRecordなので、実際に重複した
  // 列を区別できないのは既知の仕様——ここではその挙動が例外を投げない
  // ことだけを確認する)。
  const mapping = buildSuggestedMapping(["商品名", "商品名"], TEST_TARGETS);
  assertEqual(mapping["商品名"], "name", "重複ヘッダー: 例外を投げず、最後の解決結果が残る");
}

function testNormalizeAndStrip() {
  assertEqual(normalizeImportHeaderLabel("商品名"), normalizeImportHeaderLabel("商品名　"), "正規化: 全角/半角スペースの畳み込み");
  assertEqual(stripLeadingDecoration("★商品名"), "商品名", "装飾除去: 先頭の★を除去");
  assertEqual(stripLeadingDecoration("商品★名"), "商品★名", "装飾除去: 先頭以外の記号は保持(意味のある記号を壊さない)");
}

// ── XLSX: 実際にExcelJSでファイルを生成し、parseXlsxFileで読み戻す ──
async function testParseXlsxRoundTrip() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["商品名", "数量", "仕入日"]);
  sheet.addRow(["椅子", 3, new Date(Date.UTC(2026, 7, 27))]); // 2026-08-27, monthは0始まり
  sheet.addRow(["机", "", ""]); // 空値混在行
  const buffer = await workbook.xlsx.writeBuffer();

  const { headers, rows } = await parseXlsxFile(buffer as ArrayBuffer);
  assertEqual(headers, ["商品名", "数量", "仕入日"], "XLSX: ヘッダー抽出");
  assertEqual(rows[0], { 商品名: "椅子", 数量: "3", 仕入日: "2026/08/27" }, "XLSX: Dateセルは YYYY/MM/DD 文字列へ正規化される(parseImportDateがこの形式を受け付ける)");
  assertEqual(rows.length, 2, "XLSX: 「机」行は数量/仕入日が空でも商品名があるので保持される(hasValueは行内のどれか1セルでも真なら真)");
  assertEqual(rows[1], { 商品名: "机", 数量: "", 仕入日: "" }, "XLSX: 部分的に空欄の行は空セルを空文字として保持する");
}

async function testParseXlsxKeepsRowWithPartialData() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["商品名", "数量"]);
  sheet.addRow(["机", ""]); // 数量だけ空——商品名があるので行自体は残るべき
  sheet.addRow(["", ""]); // 全部空——除外されるべき
  const buffer = await workbook.xlsx.writeBuffer();

  const { rows } = await parseXlsxFile(buffer as ArrayBuffer);
  assertEqual(rows.length, 1, "XLSX: 一部の値だけ空欄の行は保持し、全欄が空の行だけ除外する");
  assertEqual(rows[0], { 商品名: "机", 数量: "" }, "XLSX: 保持された行の空セルは空文字になる(nullではない)");
}

async function main() {
  testParseCsvQuoting();
  testParseCsvBom();
  testParseCsvRoundTrip();
  testParseCsvFileMissingCells();
  testParseCsvFileEmpty();
  testParseImportNumber();
  testParseImportDate();
  testBuildSuggestedMapping();
  testBuildSuggestedMappingAlias();
  testBuildSuggestedMappingDecoration();
  testBuildSuggestedMappingDuplicateHeaders();
  testNormalizeAndStrip();
  await testParseXlsxRoundTrip();
  await testParseXlsxKeepsRowWithPartialData();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
