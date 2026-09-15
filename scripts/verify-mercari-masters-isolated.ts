/**
 * P1是正(2026-09-15)の回帰試験: 「data/mercari-masters/がSSR成果物に
 * 同梱されない本番環境」を再現し、その状態でもカテゴリ/ブランド
 * マスタが実IDで読める(=`lib/listing/mercari/csv/masters.ts`が
 * `process.cwd()`配下の`data/`に一切依存しない)ことを検証する。
 *
 * 旧実装の不具合(実測): `path.join(process.cwd(), "data", "mercari-masters", ...)`
 * を実行時に`fs.readFileSync`していたため、Amplify Hosting SSRの
 * ビルド成果物選別(Next.jsのfile tracing、@vercel/nftベース)が
 * `process.cwd()`を静的解決できず本番へ同梱されなかった。ローカルの
 * `scripts/verify-mercari-csv-export.ts`のtestMastersは常にリポジトリ
 * 直下がcwdのまま実行されるため、この不具合を検出できていなかった
 * (「結果を既存作業ツリーで読むだけの試験では不十分」)。
 *
 * この試験は、`data/mercari-masters/`が存在しない一時ディレクトリへ
 * 実際にプロセスのcwdを退避してからマスタ読込関数を呼び、本番の
 * 「data/が同梱されない」状況を再現する。修正後は静的import
 * (`./generated/*.generated.json`、webpackが実行時ファイル探索なしで
 * バンドルへ埋め込む)経由でしか読まないため、cwdに依存せず成功する。
 *
 * 実行: node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-mercari-masters-isolated.ts
 * (npm run verify:mercari-masters-isolated が prehook で
 * scripts/generate-mercari-masters-data.cjs を先に実行する)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
let passes = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

async function main() {
  const originalCwd = process.cwd();
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mercari-masters-isolated-"));

  try {
    assertTrue(
      !fs.existsSync(path.join(isolatedCwd, "data", "mercari-masters")),
      "隔離ディレクトリにdata/mercari-masters/が存在しない(本番でSSR成果物にdata/が同梱されない状況の再現)",
    );

    process.chdir(isolatedCwd);
    assertEqual(process.cwd(), fs.realpathSync(isolatedCwd), "process.cwd()を実際にdata/を持たない隔離ディレクトリへ切り替えた");

    // masters.tsの実装が静的import(webpackバンドル埋込み相当)のみに
    // 依存していることを確認するため、cwd切替え「後」にimportする
    // (cwd切替え前にキャッシュされた値を使い回して見かけ上通ってしまう
    // ことを避ける)。
    const {
      hasBrandMaster,
      hasCategoryMaster,
      loadBrandMaster,
      loadCategoryMaster,
      getBrandById,
      getCategoryById,
      searchBrands,
      searchCategories,
    } = await import("../lib/listing/mercari/csv/masters");
    const { loadMercariCsvHeader, isHeaderVerified, MERCARI_CSV_COLUMN_COUNT } = await import("../lib/listing/mercari/csv/header");

    assertTrue(hasBrandMaster(), "cwdにdata/が無くてもブランドマスタは読み込める(hasBrandMaster)");
    assertTrue(hasCategoryMaster(), "cwdにdata/が無くてもカテゴリマスタは読み込める(hasCategoryMaster)");

    const brands = loadBrandMaster();
    const categories = loadCategoryMaster();
    assertTrue(!!brands && brands.length > 50000, "隔離環境でもブランド実件数(>50000件)が読める");
    assertTrue(!!categories && categories.length > 7000, "隔離環境でもカテゴリ実件数(>7000件)が読める");

    const knownBrand = getBrandById("225nDaWCk4MpMbnFP6a5An");
    assertEqual(knownBrand?.name, "Xmiss", "隔離環境でも既知の実brandIdが正しい名称に解決する(文字化けなし)");

    const knownCategory = getCategoryById("iBDxa3BbcUz8XWrr5pgq2Z");
    assertEqual(
      knownCategory?.fullPath,
      "CD・DVD・ブルーレイ > CD > K-POP・アジア",
      "隔離環境でも既知の実categoryIdがフルパス込みで正しく解決する(日本語文字化けなし)",
    );

    const brandHits = searchBrands("Xmiss");
    assertTrue(brandHits.length >= 1 && brandHits.length <= 50, "隔離環境でもブランド検索が上限付きで機能する");

    const categoryHits = searchCategories("K-POP");
    assertTrue(categoryHits.length >= 1, "隔離環境でもカテゴリ検索が機能する");
    assertTrue(
      categoryHits.every((c) => c.fullPath.length > 0),
      "隔離環境でもカテゴリ検索結果は常にfullPathを伴う",
    );

    assertEqual(getBrandById("does-not-exist"), null, "隔離環境でも未知のbrandIdはnull(捏造しない)");
    assertEqual(getCategoryById("does-not-exist"), null, "隔離環境でも未知のcategoryIdはnull(捏造しない)");

    const header = loadMercariCsvHeader();
    assertEqual(header.source, "official-file", "隔離環境でもCSVヘッダーはofficial-file(原本)から読める(fallbackへ落ちない)");
    assertTrue(isHeaderVerified(header), "隔離環境でもisHeaderVerified()がtrue(本番CSV生成がブロックされない)");
    assertEqual(header.columns.length, MERCARI_CSV_COLUMN_COUNT, "隔離環境でもヘッダーが88列そのまま読める");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    process.exit(1);
  }
}

main();
