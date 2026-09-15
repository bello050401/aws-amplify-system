import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";
import { buildFurnitureCategoryBuckets, type FurnitureCategoryBucket } from "./furnitureCategoryTree";

export type { FurnitureCategoryBucket, FurnitureCategoryNode, FurnitureCategoryLeaf } from "./furnitureCategoryTree";

/**
 * ブランド/カテゴリマスタの読み込みと検索。
 *
 * 指示書§4「全ブランド数万件を初期JSへ埋込まず必要時検索/結果上限」
 * の通り、マスタはビルド成果物へ埋め込まず、サーバー側で
 * `data/mercari-masters/*.csv` を実行時に読む(Next.jsのServer
 * Action/RSCから呼ばれる前提。ブラウザバンドルには含めない)。
 *
 * 提供元:
 *  - brand_master.csv ← 提供物 brand_master_sjis.csv(CP932)を
 *    そのまま配置。ブランドID/ブランド名/ブランド名（カナ）/
 *    ブランド名（英語）。
 *  - category_master.csv ← 提供物 category_master_updated_sjis.csv
 *    (ファイル名に反しUTF-8)をそのまま配置。カテゴリID/カテゴリ名/
 *    カテゴリ名（フル）。
 *
 * 提供物ディレクトリから上記2ファイルをそのまま`data/mercari-masters/`へ
 * 配置済み(ブランド約52,706件、カテゴリ約7,625件、いずれも見出し行除く実
 * データ件数。`scripts/verify-mercari-csv-export.ts`のtestMasters参照)。
 * ファイルが無い環境では`hasBrandMaster`/`hasCategoryMaster`がfalseになり
 * 呼び出し側はマスタ未検出として扱う(捏造した候補を出さない)。
 */

export interface BrandMasterEntry {
  brandId: string;
  name: string;
  nameKana: string;
  nameEnglish: string;
}

export interface CategoryMasterEntry {
  categoryId: string;
  name: string;
  fullPath: string;
}

const MASTERS_DIR = path.join(process.cwd(), "data", "mercari-masters");
const BRAND_MASTER_PATH = path.join(MASTERS_DIR, "brand_master.csv");
const CATEGORY_MASTER_PATH = path.join(MASTERS_DIR, "category_master.csv");

/** ダブルクオートを含まない単純CSV前提(マスタ提供物はプレーンな列のみ)。 */
function splitSimpleCsvLine(line: string): string[] {
  return line.split(",");
}

function readCsvRows(filePath: string, encoding: "cp932" | "utf8"): string[][] | null {
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  const text = encoding === "cp932" ? iconv.decode(bytes, "cp932") : bytes.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  return lines.slice(1).map(splitSimpleCsvLine); // 先頭行はヘッダーなので除く
}

let brandCache: BrandMasterEntry[] | null | undefined;
let categoryCache: CategoryMasterEntry[] | null | undefined;

export function loadBrandMaster(): BrandMasterEntry[] | null {
  if (brandCache !== undefined) return brandCache;
  const rows = readCsvRows(BRAND_MASTER_PATH, "cp932");
  brandCache = rows
    ? rows
        .filter((r) => r.length >= 4 && r[0])
        .map((r) => ({ brandId: r[0], name: r[1] ?? "", nameKana: r[2] ?? "", nameEnglish: r[3] ?? "" }))
    : null;
  return brandCache;
}

export function loadCategoryMaster(): CategoryMasterEntry[] | null {
  if (categoryCache !== undefined) return categoryCache;
  const rows = readCsvRows(CATEGORY_MASTER_PATH, "utf8");
  categoryCache = rows
    ? rows
        .filter((r) => r.length >= 3 && r[0])
        .map((r) => ({ categoryId: r[0], name: r[1] ?? "", fullPath: r[2] ?? "" }))
    : null;
  return categoryCache;
}

export function hasBrandMaster(): boolean {
  return loadBrandMaster() !== null;
}

export function hasCategoryMaster(): boolean {
  return loadCategoryMaster() !== null;
}

const SEARCH_RESULT_LIMIT = 50;

/** 和名/カナ/英名の部分一致検索。結果は上限件数で打ち切る(全件返さない)。 */
export function searchBrands(query: string, limit = SEARCH_RESULT_LIMIT): BrandMasterEntry[] {
  const master = loadBrandMaster();
  if (!master) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return master
    .filter(
      (b) =>
        b.name.toLowerCase().includes(q) || b.nameKana.toLowerCase().includes(q) || b.nameEnglish.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

/**
 * カテゴリ名(末端)での検索。同名の末端カテゴリが複数IDに存在しうる
 * ため、`fullPath`(フルパス)を必ず一緒に返す——呼び出し側はAIや
 * 文字列類似だけでID確定してはならず、フルパスをユーザーに見せて
 * 選ばせる。
 */
export function searchCategories(query: string, limit = SEARCH_RESULT_LIMIT): CategoryMasterEntry[] {
  const master = loadCategoryMaster();
  if (!master) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return master
    .filter((c) => c.name.toLowerCase().includes(q) || c.fullPath.toLowerCase().includes(q))
    .slice(0, limit);
}

export function getCategoryById(categoryId: string): CategoryMasterEntry | null {
  const master = loadCategoryMaster();
  return master?.find((c) => c.categoryId === categoryId) ?? null;
}

export function getBrandById(brandId: string): BrandMasterEntry | null {
  const master = loadBrandMaster();
  return master?.find((b) => b.brandId === brandId) ?? null;
}

let furnitureBucketsCache: FurnitureCategoryBucket[] | undefined;

/**
 * 家具店向け効率化指示書(2026-09-15) §4-A/G: 「家具・インテリア」配下
 * だけの8入口カテゴリ木。木の組み立て自体は
 * `lib/listing/mercari/csv/furnitureCategoryTree.ts`(fs非依存の純粋関数、
 * クライアント側のパンくず復元・家具内検索でも使い回す)に切り出して
 * あり、ここではその結果をプロセス内で1回だけ計算してキャッシュする
 * ——§4-G「カテゴリ木はサーバーキャッシュで軽量化、枝のクリック毎の
 * 全件マスタ再読込を避ける」。呼び出し側(Server Action経由)はこの
 * 結果をクライアントへ1回だけ渡し、以降のクリック操作・家具内検索は
 * 通信なしでクライアント側だけで完結する。
 */
export function getFurnitureCategoryBuckets(): FurnitureCategoryBucket[] {
  if (furnitureBucketsCache !== undefined) return furnitureBucketsCache;
  const master = loadCategoryMaster();
  furnitureBucketsCache = buildFurnitureCategoryBuckets(master ?? []);
  return furnitureBucketsCache;
}

/** テスト用: キャッシュを破棄する(合成fixtureを切り替えて再読込するため)。 */
export function resetMastersCacheForTests(): void {
  brandCache = undefined;
  categoryCache = undefined;
  furnitureBucketsCache = undefined;
}
