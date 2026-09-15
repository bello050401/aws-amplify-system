import generatedProductImportHeader from "./generated/product-import-header.generated.json";

/**
 * Mercari Shops 商品一括登録CSV(product_import_template.csv)のヘッダー。
 *
 * 原本(CP932/BOMなし/LF/88列/ヘッダーのみ、提供物ディレクトリ
 * `product_import_template.csv`)は`data/mercari-masters/
 * product_import_template.csv`にそのまま配置済み(git追跡済み)。
 *
 * ## 実行時fs読込をやめた理由(2026-09-15是正、実測)
 *
 * 以前はここも`data/mercari-masters/*.csv`と同じく`process.cwd()`基準で
 * 実行時にfs読込していたが、`lib/listing/mercari/csv/masters.ts`と全く
 * 同じ原因(Amplify Hosting SSRのビルド成果物選別=Next.jsのfile
 * tracing、@vercel/nftベース、が`process.cwd()`を静的解決できない)で
 * 本番のみ原本が読めず、`isHeaderVerified`が常にfalseになって
 * `buildMercariCsvExport`がCSV生成そのものをブロックする状態になって
 * いた(P1是正、masters.tsのコメント参照)。
 * `scripts/generate-mercari-masters-data.cjs`がビルド時(prebuild/predev)
 * に原本のヘッダー行(1行目、88列)をJSONへ変換し、ここでは通常の
 * 相対importとして読み込む。webpackが静的にバンドルへ埋め込むため、
 * 実行時のファイル探索自体が無くなる。
 *
 * `MERCARI_CSV_FALLBACK_HEADER`(このファイル内の再構成ヘッダー)は
 * 生成スクリプトが原本を読めなかった場合(=ビルド自体が失敗する)向けの
 * 保険として残す。83〜87列目(予約関連5列)は当初mojibake化した原本の
 * 断片からは復元できずプレースホルダーだったが、原本確認後の実値は
 * 「発売日/予約受付開始日/予約受付終了日/キャンセル期限/お届け予定」——
 * これらの列はofficial-file読み込み時のみ正しい値になり、fallback定数側は
 * 意図的にプレースホルダーのまま(fallbackしか無い環境で予約関連列を
 * 捏造しないため)。本番CSV生成はofficial-fileが無い限りブロックする
 * (`isHeaderVerified`参照)。
 */

export const MERCARI_CSV_COLUMN_COUNT = 88;

const SKU_FIELD_SUFFIXES = ["種類", "在庫数", "商品管理コード", "JANコード", "catalog_id"] as const;

/** 83〜87列目(未確認) — 原本ファイルが手に入るまでの仮ラベル。 */
const UNVERIFIED_TAIL_COLUMNS = [
  "（要確認_83列目）",
  "（要確認_84列目）",
  "（要確認_85列目）",
  "（要確認_86列目）",
  "（要確認_87列目）",
] as const;

function buildFallbackHeader(): string[] {
  const cols: string[] = [];
  for (let i = 1; i <= 20; i++) cols.push(`商品画像名_${i}`);
  cols.push("商品名", "商品説明");
  for (let sku = 1; sku <= 10; sku++) {
    for (const suffix of SKU_FIELD_SUFFIXES) cols.push(`SKU${sku}_${suffix}`);
  }
  cols.push(
    "ブランドID",
    "販売価格",
    "カテゴリID",
    "商品の状態",
    "配送方法",
    "発送元の地域",
    "発送までの日数",
    "商品ステータス",
    "配送料の負担",
    "送料ID",
    ...UNVERIFIED_TAIL_COLUMNS,
    "メルカリBiz配送_クール区分",
  );
  return cols;
}

export const MERCARI_CSV_FALLBACK_HEADER: readonly string[] = Object.freeze(buildFallbackHeader());

if (MERCARI_CSV_FALLBACK_HEADER.length !== MERCARI_CSV_COLUMN_COUNT) {
  throw new Error(
    `internal error: fallback Mercari CSV header has ${MERCARI_CSV_FALLBACK_HEADER.length} columns, expected ${MERCARI_CSV_COLUMN_COUNT}`,
  );
}

export interface MercariCsvHeaderResult {
  columns: readonly string[];
  source: "official-file" | "fallback-reconstruction";
}

const productImportHeaderColumns: string[] = generatedProductImportHeader;

/**
 * ヘッダーを読み込む。ビルド時に静的importされた
 * `generated/product-import-header.generated.json`(原本1行目、88列)を
 * そのまま使う。列数が合わない生成物は壊れているとみなしfallbackへ
 * (生成スクリプト自体が88列チェック済みなので通常は起こらない)。
 */
export function loadMercariCsvHeader(): MercariCsvHeaderResult {
  if (productImportHeaderColumns.length === MERCARI_CSV_COLUMN_COUNT) {
    return { columns: productImportHeaderColumns, source: "official-file" };
  }
  console.error(
    `[loadMercariCsvHeader] generated header has ${productImportHeaderColumns.length} columns, expected ${MERCARI_CSV_COLUMN_COUNT} — using fallback`,
  );
  return { columns: MERCARI_CSV_FALLBACK_HEADER, source: "fallback-reconstruction" };
}

/** 本番用(実際にMercariへ取り込ませる)CSV生成を許可してよいか。 */
export function isHeaderVerified(result: MercariCsvHeaderResult): boolean {
  return result.source === "official-file";
}
