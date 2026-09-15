import { buildFurnitureCategoryBuckets, type FurnitureCategoryBucket } from "./furnitureCategoryTree";
export type { FurnitureCategoryBucket, FurnitureCategoryNode, FurnitureCategoryLeaf } from "./furnitureCategoryTree";
import generatedBrandMaster from "./generated/brand-master.generated.json";
import generatedCategoryMaster from "./generated/category-master.generated.json";


/**
 * ブランド/カテゴリマスタの読み込みと検索。
 *
 * 指示書§4「全ブランド数万件を初期JSへ埋込まず必要時検索/結果上限」
 * の通り、マスタ全量はブラウザへは送らない——ここから検索するのは
 * サーバー側(Server Action/RSC)からのみで、返す件数自体を
 * `SEARCH_RESULT_LIMIT`で絞る。
 *
 * ## 実行時fs読込をやめた理由(2026-09-15是正、実測)
 *
 * 以前はサーバー側で`data/mercari-masters/*.csv`を`process.cwd()`基準で
 * 実行時に読んでいたが、公開a1a7a46配信後、本番では
 * 「カテゴリマスタが読み込めない(category_master.csv未検出)」で失敗
 * した(ローカルE2E/単体/buildはすべて成功)。原因はAmplify Hosting SSRの
 * ビルド成果物選別(Next.jsのfile tracing、@vercel/nftベース)——
 * `process.cwd()`はビルド時点で値が定まらないため、tracerがこの参照を
 * 静的解決できず`data/mercari-masters/*.csv`が本番SSR成果物に同梱され
 * ない(ローカルはリポジトリ直下がcwdになるので偶然動いていた)。
 *
 * 対策として、CSV原本(`data/mercari-masters/`、git追跡済み)を
 * `scripts/generate-mercari-masters-data.cjs`でビルド時(prebuild/predev)
 * にJSONへ変換し、ここでは通常の相対importとして読み込む形にした。
 * webpackが静的にバンドルへ埋め込むため、実行時のファイル探索自体が
 * 無くなり、Amplifyの成果物選別の影響を受けない。
 *
 * 提供元:
 *  - data/mercari-masters/brand_master.csv ← 提供物 brand_master_sjis.csv
 *    (CP932)をそのまま配置。ブランドID/ブランド名/ブランド名（カナ）/
 *    ブランド名（英語）。
 *  - data/mercari-masters/category_master.csv ← 提供物
 *    category_master_updated_sjis.csv(ファイル名に反しUTF-8)をそのまま
 *    配置。カテゴリID/カテゴリ名/カテゴリ名（フル）。
 *
 * 実件数はブランド約52,706件、カテゴリ約7,625件(いずれも見出し行除く。
 * `scripts/verify-mercari-csv-export.ts`のtestMasters参照)。
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

const brandMaster = generatedBrandMaster as BrandMasterEntry[];
const categoryMaster = generatedCategoryMaster as CategoryMasterEntry[];

export function loadBrandMaster(): BrandMasterEntry[] | null {
  return brandMaster.length > 0 ? brandMaster : null;
}

export function loadCategoryMaster(): CategoryMasterEntry[] | null {
  return categoryMaster.length > 0 ? categoryMaster : null;
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
