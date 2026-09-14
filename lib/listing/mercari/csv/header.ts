import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

/**
 * Mercari Shops 商品一括登録CSV(product_import_template.csv)のヘッダー。
 *
 * 原本(CP932/BOMなし/LF/88列/ヘッダーのみ、提供物ディレクトリ
 * `product_import_template.csv`)はこのworktreeの
 * `data/mercari-masters/product_import_template.csv`にそのまま配置済みで、
 * CP932として正しくデコードして読める(`loadMercariCsvHeader`が
 * `source: "official-file"`を返す。検証は
 * `scripts/verify-mercari-csv-export.ts`のtestHeader参照)。
 *
 * `MERCARI_CSV_FALLBACK_HEADER`(このファイル内の再構成ヘッダー)は原本が
 * 未配置の環境向けの保険として残す。83〜87列目(予約関連5列)は当初
 * mojibake化した原本の断片からは復元できずプレースホルダーだったが、
 * 原本確認後の実値は「発売日/予約受付開始日/予約受付終了日/
 * キャンセル期限/お届け予定」——これらの列はofficial-file読み込み時のみ
 * 正しい値になり、fallback定数側は意図的にプレースホルダーのまま
 * (fallbackしか無い環境で予約関連列を捏造しないため)。
 * 本番CSV生成はofficial-fileが無い限りブロックする(`isHeaderVerified`参照)。
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
  sourcePath?: string;
}

function officialHeaderPath(): string {
  return path.join(process.cwd(), "data", "mercari-masters", "product_import_template.csv");
}

/**
 * ヘッダーを読み込む。`data/mercari-masters/product_import_template.csv`が
 * あればそれをCP932としてデコードし、88列であることを確認してから使う
 * (列数が合わなければ壊れたファイルとして無視しfallbackへ)。
 */
export function loadMercariCsvHeader(): MercariCsvHeaderResult {
  const officialPath = officialHeaderPath();
  try {
    if (fs.existsSync(officialPath)) {
      const bytes = fs.readFileSync(officialPath);
      const text = iconv.decode(bytes, "cp932");
      const firstLine = text.split(/\r\n|\n/, 1)[0] ?? "";
      const columns = firstLine.length > 0 ? firstLine.split(",") : [];
      if (columns.length === MERCARI_CSV_COLUMN_COUNT) {
        return { columns, source: "official-file", sourcePath: officialPath };
      }
      console.error(
        `[loadMercariCsvHeader] ${officialPath} has ${columns.length} columns, expected ${MERCARI_CSV_COLUMN_COUNT} — ignoring, using fallback`,
      );
    }
  } catch (err) {
    console.error(`[loadMercariCsvHeader] failed to read ${officialPath}:`, err);
  }
  return { columns: MERCARI_CSV_FALLBACK_HEADER, source: "fallback-reconstruction" };
}

/** 本番用(実際にMercariへ取り込ませる)CSV生成を許可してよいか。 */
export function isHeaderVerified(result: MercariCsvHeaderResult): boolean {
  return result.source === "official-file";
}
