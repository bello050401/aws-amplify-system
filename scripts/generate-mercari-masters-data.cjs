/**
 * data/mercari-masters/{brand,category}_master.csv (提供物そのまま、
 * git追跡済み) を、lib/listing/mercari/csv/masters.ts が静的import
 * できるJSONへビルド時に変換する。
 *
 * ## なぜ実行時fs読込ではなくこれが要るか(実測)
 *
 * 公開a1a7a46配信後、Codex実ブラウザで保存済み商品詳細を開くと
 * 「カテゴリマスタが読み込めない(category_master.csv未検出)」が発生
 * した。ローカルのE2E/単体/buildはすべて成功していたにもかかわらず
 * 本番でだけ失敗する——原因はAmplify Hosting SSRのビルド成果物選別
 * (Next.jsのfile tracing、@vercel/nftベース)にある。旧実装は
 * `path.join(process.cwd(), "data", "mercari-masters", ...)` を実行時に
 * fs.readFileSyncしていたが、`process.cwd()`はビルド時点で値が定まらない
 * ため、tracerはこの参照を静的解決できず、`data/mercari-masters/*.csv`
 * が本番SSR成果物に同梱されない(ローカルはリポジトリ直下がcwdになる
 * ので偶然動いていただけ)。
 *
 * このスクリプトはCSVを一度だけ読み、webpackが確実にバンドルへ埋め込める
 * 通常の相対import(`import data from "./generated/xxx.generated.json"`)
 * 経由で使える形に変換しておく——実行時のファイル探索自体を無くす。
 *
 * 生成物(lib/listing/mercari/csv/generated/*.generated.json)はビルド成果物
 * なのでgit管理しない(.gitignore参照)。`npm run build`/`npm run dev`の
 * 前(prebuild/predev)に毎回このスクリプトが走る。
 *
 * 実行: node scripts/generate-mercari-masters-data.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const iconv = require("iconv-lite");

const REPO_ROOT = path.join(__dirname, "..");
const MASTERS_DIR = path.join(REPO_ROOT, "data", "mercari-masters");
const OUT_DIR = path.join(REPO_ROOT, "lib", "listing", "mercari", "csv", "generated");

/** ダブルクオートを含まない単純CSV前提(マスタ提供物はプレーンな列のみ)。masters.tsの旧実装と同一仕様。 */
function splitSimpleCsvLine(line) {
  return line.split(",");
}

function readCsvRows(filePath, encoding) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Mercariマスタ原本が見つかりません: ${filePath} (data/mercari-masters/はgit追跡済みのはずです)`);
  }
  const bytes = fs.readFileSync(filePath);
  const text = encoding === "cp932" ? iconv.decode(bytes, "cp932") : bytes.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  return lines.slice(1).map(splitSimpleCsvLine); // 先頭行はヘッダーなので除く
}

function buildBrandMaster() {
  const rows = readCsvRows(path.join(MASTERS_DIR, "brand_master.csv"), "cp932");
  return rows
    .filter((r) => r.length >= 4 && r[0])
    .map((r) => ({ brandId: r[0], name: r[1] ?? "", nameKana: r[2] ?? "", nameEnglish: r[3] ?? "" }));
}

function buildCategoryMaster() {
  const rows = readCsvRows(path.join(MASTERS_DIR, "category_master.csv"), "utf8");
  return rows
    .filter((r) => r.length >= 3 && r[0])
    .map((r) => ({ categoryId: r[0], name: r[1] ?? "", fullPath: r[2] ?? "" }));
}

const PRODUCT_IMPORT_HEADER_COLUMN_COUNT = 88;

/**
 * lib/listing/mercari/csv/header.ts が使う、公式CSV取込テンプレートの
 * ヘッダー行(1行目、88列)。masters.tsのbrand/categoryと同じ理由
 * (process.cwd()基準のfs読込がAmplify SSR成果物へ同梱されない)で
 * ここでも静的importへ切り替える対象。
 */
function buildProductImportHeader() {
  const filePath = path.join(MASTERS_DIR, "product_import_template.csv");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Mercariマスタ原本が見つかりません: ${filePath} (data/mercari-masters/はgit追跡済みのはずです)`);
  }
  const bytes = fs.readFileSync(filePath);
  const text = iconv.decode(bytes, "cp932");
  const firstLine = text.split(/\r\n|\n/, 1)[0] ?? "";
  const columns = firstLine.length > 0 ? splitSimpleCsvLine(firstLine) : [];
  if (columns.length !== PRODUCT_IMPORT_HEADER_COLUMN_COUNT) {
    throw new Error(
      `product_import_template.csvのヘッダーが${columns.length}列です(期待${PRODUCT_IMPORT_HEADER_COLUMN_COUNT}列) — 原本が壊れている可能性があります`,
    );
  }
  return columns;
}

function main() {
  const brands = buildBrandMaster();
  const categories = buildCategoryMaster();
  const productImportHeader = buildProductImportHeader();

  if (brands.length < 50000) {
    throw new Error(`brand_master.csvの実データ件数が想定を下回ります(${brands.length}件、期待>50000件)`);
  }
  if (categories.length < 7000) {
    throw new Error(`category_master.csvの実データ件数が想定を下回ります(${categories.length}件、期待>7000件)`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "brand-master.generated.json"), JSON.stringify(brands));
  fs.writeFileSync(path.join(OUT_DIR, "category-master.generated.json"), JSON.stringify(categories));
  fs.writeFileSync(path.join(OUT_DIR, "product-import-header.generated.json"), JSON.stringify(productImportHeader));

  console.log(
    `[generate-mercari-masters-data] brand: ${brands.length}件, category: ${categories.length}件, header: ${productImportHeader.length}列 -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
  );
}

main();
