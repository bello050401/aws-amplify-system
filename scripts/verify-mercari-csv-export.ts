/**
 * Mercari Shops CSV export (lib/listing/mercari/csv/*) の合成fixtureテスト。
 * 外部アクセス(実DynamoDB/実S3/実マスタファイル)は一切行わない——
 * すべて純粋関数への直接呼び出しか、テスト内で組み立てた合成データ。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-mercari-csv-export.ts
 */
import { MERCARI_CSV_FALLBACK_HEADER, MERCARI_CSV_COLUMN_COUNT, loadMercariCsvHeader, isHeaderVerified } from "../lib/listing/mercari/csv/header";
import { assembleMercariCsvRowFields, imageFilename, type CsvSourceInventory } from "../lib/listing/mercari/csv/assembleRow";
import { buildStoredZip } from "../lib/listing/mercari/csv/imageZip";
import { crc32 } from "../lib/listing/mercari/csv/crc32";
import type { ChannelListingRecord, ListingDraftRecord } from "../lib/listing/types";
import { encodeCp932Strict, decodeCp932, isCp932Representable } from "../lib/listing/mercari/csv/cp932";
import { csvQuoteCell, buildCsvText, encodeMercariCsv } from "../lib/listing/mercari/csv/serialize";
import { parseCsvIndependent } from "../lib/listing/mercari/csv/independentParse";
import { unicodeLength, validateMercariCsvRow, detectFormulaInjectionRisk } from "../lib/listing/mercari/csv/validate";
import { mapRowToCells } from "../lib/listing/mercari/csv/mapRowToCells";
import { buildMercariCsvExport } from "../lib/listing/mercari/csv/exportCsv";
import type { MercariCsvRowFields } from "../lib/listing/mercari/csv/types";
import {
  hasBrandMaster,
  hasCategoryMaster,
  loadBrandMaster,
  loadCategoryMaster,
  searchBrands,
  searchCategories,
  getBrandById,
  getCategoryById,
} from "../lib/listing/mercari/csv/masters";

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

function baseFields(overrides: Partial<MercariCsvRowFields> = {}): MercariCsvRowFields {
  return {
    inventoryId: "inv-1",
    displayId: "B000001",
    images: ["B000001_1.jpg", "B000001_2.jpg"],
    productName: "テスト商品",
    productDescription: "説明文\n複数行\nテスト",
    skuType: null,
    quantity: 1,
    managementCode: "B000001",
    janCode: "4901234567894",
    catalogId: null,
    brandId: null,
    salePrice: 1000,
    categoryId: "cat-001",
    condition: 3,
    shippingMethod: 3,
    shippingOriginArea: "jp11",
    shippingDays: 2,
    productStatus: 1,
    shippingPayer: 1,
    shippingFeeId: null,
    bizCoolCategory: null,
    ...overrides,
  };
}

// --- 1. ヘッダー: 88列固定。data/mercari-masters/product_import_template.csv
// (提供物からそのまま配置した原本、CP932/BOMなし/LF)が存在するため、
// source="official-file"で読み込まれ、内容が原本と完全一致することを検証する。
// fallback定数(MERCARI_CSV_FALLBACK_HEADER)は原本が無い環境向けの保険として
// 別途、既知83列分の値を検証する。
function testHeader() {
  assertEqual(MERCARI_CSV_FALLBACK_HEADER.length, MERCARI_CSV_COLUMN_COUNT, "fallback header has exactly 88 columns");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[0], "商品画像名_1", "header col 1 = 商品画像名_1");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[19], "商品画像名_20", "header col 20 = 商品画像名_20");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[20], "商品名", "header col 21 = 商品名");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[21], "商品説明", "header col 22 = 商品説明");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[22], "SKU1_種類", "header col 23 = SKU1_種類");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[26], "SKU1_catalog_id", "header col 27 = SKU1_catalog_id");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[71], "SKU10_catalog_id", "header col 72 = SKU10_catalog_id");
  assertEqual(MERCARI_CSV_FALLBACK_HEADER[87], "メルカリBiz配送_クール区分", "header col 88 = メルカリBiz配送_クール区分");

  const loaded = loadMercariCsvHeader();
  assertEqual(loaded.source, "official-file", "data/mercari-masters/product_import_template.csv is present -> official source");
  assertTrue(isHeaderVerified(loaded), "isHeaderVerified() is true once the official file is loaded");
  assertEqual(loaded.columns.length, MERCARI_CSV_COLUMN_COUNT, "official header also has exactly 88 columns");
  // fallback定数と原本は83〜87列目(予約関連、当時未確認としてプレースホルダーだった)
  // 以外は完全一致する。原本判明後の実値で置き換え、両方を固定検証する。
  const OFFICIAL_TAIL_83_TO_87 = ["発売日", "予約受付開始日", "予約受付終了日", "キャンセル期限", "お届け予定"];
  for (let i = 0; i < 88; i++) {
    if (i >= 82 && i <= 86) {
      assertEqual(loaded.columns[i], OFFICIAL_TAIL_83_TO_87[i - 82], `official header col ${i + 1} matches provided template.csv`);
    } else {
      assertEqual(loaded.columns[i], MERCARI_CSV_FALLBACK_HEADER[i], `official header col ${i + 1} matches fallback reconstruction`);
    }
  }
}

// --- 2. CP932往復 ---
function testCp932RoundTrip() {
  const ok = encodeCp932Strict("メルカリShops テスト123");
  assertTrue(ok.ok, "CP932 encodes common JP text");
  if (ok.ok) {
    assertEqual(decodeCp932(ok.buffer), "メルカリShops テスト123", "CP932 round trip preserves text");
  }
  // 絵文字はCP932で表現できない -> 検出できること
  const bad = encodeCp932Strict("価格😀");
  assertTrue(!bad.ok, "emoji is not CP932-representable and is detected");
  if (!bad.ok) {
    assertEqual(bad.invalidChar, "😀", "invalid char position/value reported for emoji");
  }
  assertTrue(isCp932Representable("通常の日本語"), "isCp932Representable true for plain JP text");
  assertTrue(!isCp932Representable("🎉"), "isCp932Representable false for emoji");
}

// --- 3. 文字数境界(Unicodeコードポイント単位) ---
function testUnicodeLength() {
  assertEqual(unicodeLength("a".repeat(130)), 130, "ascii length count");
  assertEqual(unicodeLength("あ".repeat(130)), 130, "JP char length count");
  // サロゲートペア(絵文字)は1文字として数える
  assertEqual(unicodeLength("😀"), 1, "surrogate pair counted as 1 code point");
  assertEqual(unicodeLength("😀".repeat(130)), 130, "130 emoji counted as 130, not 260");
}

// --- 4. 商品名/説明の境界値 ---
function testTitleDescriptionBoundaries() {
  const ok130 = validateMercariCsvRow(baseFields({ productName: "あ".repeat(130) }));
  assertTrue(ok130.ok, "130-char title is accepted (boundary, inclusive)");
  const over131 = validateMercariCsvRow(baseFields({ productName: "あ".repeat(131) }));
  assertTrue(!over131.ok, "131-char title is rejected");
  const desc3000 = validateMercariCsvRow(baseFields({ productDescription: "a".repeat(3000) }));
  assertTrue(desc3000.ok, "3000-char description is accepted (boundary)");
  const desc3001 = validateMercariCsvRow(baseFields({ productDescription: "a".repeat(3001) }));
  assertTrue(!desc3001.ok, "3001-char description is rejected");
  const emptyTitle = validateMercariCsvRow(baseFields({ productName: "" }));
  assertTrue(!emptyTitle.ok, "empty title is rejected");
}

// --- 5. 価格上下限/非整数 ---
function testPriceBounds() {
  assertTrue(validateMercariCsvRow(baseFields({ salePrice: 300 })).ok, "price 300 (lower bound) accepted");
  assertTrue(validateMercariCsvRow(baseFields({ salePrice: 9999999 })).ok, "price 9999999 (upper bound) accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ salePrice: 299 })).ok, "price 299 rejected");
  assertTrue(!validateMercariCsvRow(baseFields({ salePrice: 10000000 })).ok, "price 10000000 rejected");
  assertTrue(!validateMercariCsvRow(baseFields({ salePrice: 1000.5 })).ok, "non-integer price rejected");
}

// --- 6. 数量欠損/不正 ---
function testQuantity() {
  assertTrue(validateMercariCsvRow(baseFields({ quantity: 1 })).ok, "quantity 1 accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ quantity: 0 })).ok, "quantity 0 is blocked conservatively (spec ambiguous)");
  assertTrue(!validateMercariCsvRow(baseFields({ quantity: -1 })).ok, "negative quantity rejected");
  assertTrue(!validateMercariCsvRow(baseFields({ quantity: 1.5 })).ok, "non-integer quantity rejected");
}

// --- 7. 管理番号/JAN 桁数・文字種 ---
function testManagementAndJanCode() {
  assertTrue(validateMercariCsvRow(baseFields({ managementCode: "A".repeat(50) })).ok, "50-char management code (boundary) accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ managementCode: "A".repeat(51) })).ok, "51-char management code rejected");
  assertTrue(!validateMercariCsvRow(baseFields({ managementCode: "商品-001" })).ok, "management code with JP chars rejected (half-width alnum/-/_ only)");
  assertTrue(!validateMercariCsvRow(baseFields({ managementCode: "" })).ok, "empty management code rejected, not silently truncated/padded");
  assertTrue(validateMercariCsvRow(baseFields({ janCode: "1".repeat(14) })).ok, "14-digit JAN (boundary) accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ janCode: "1".repeat(15) })).ok, "15-digit JAN rejected");
  assertTrue(validateMercariCsvRow(baseFields({ janCode: null })).ok, "JAN is optional -> null accepted");
}

// --- 8. ブランド/カテゴリ、配送条件 ---
function testCategoryAndShipping() {
  assertTrue(!validateMercariCsvRow(baseFields({ categoryId: "" })).ok, "empty categoryId rejected (must be resolved from master, not guessed)");
  assertTrue(!validateMercariCsvRow(baseFields({ shippingMethod: 6, bizCoolCategory: null })).ok, "Biz shipping without cool category rejected");
  assertTrue(validateMercariCsvRow(baseFields({ shippingMethod: 6, bizCoolCategory: 1 })).ok, "Biz shipping with cool category accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ shippingMethod: 3, bizCoolCategory: 1 })).ok, "non-Biz shipping with cool category set is rejected");
  assertTrue(!validateMercariCsvRow(baseFields({ shippingPayer: 2, shippingFeeId: null })).ok, "shippingPayer=送料別 without shippingFeeId rejected");
  assertTrue(validateMercariCsvRow(baseFields({ shippingPayer: 2, shippingFeeId: "fee-1" })).ok, "shippingPayer=送料別 with shippingFeeId accepted");
}

// --- 9. 画像順序/20枚境界 ---
function testImages() {
  assertTrue(!validateMercariCsvRow(baseFields({ images: [] })).ok, "0 images rejected for normal registration CSV");
  assertTrue(validateMercariCsvRow(baseFields({ images: Array.from({ length: 20 }, (_, i) => `img_${i}.jpg`) })).ok, "20 images (boundary) accepted");
  assertTrue(!validateMercariCsvRow(baseFields({ images: Array.from({ length: 21 }, (_, i) => `img_${i}.jpg`) })).ok, "21 images rejected, not silently truncated");
  const cells = mapRowToCells(baseFields({ images: ["a.jpg", "b.jpg"] }));
  assertEqual(cells[0], "a.jpg", "image column 1 preserves order");
  assertEqual(cells[1], "b.jpg", "image column 2 preserves order");
  assertEqual(cells[2], "", "unfilled image columns are blank, not fabricated");
}

// --- 10. 数式起点文字の検出 ---
function testFormulaInjection() {
  assertTrue(detectFormulaInjectionRisk("=SUM(A1)"), "detects leading =");
  assertTrue(detectFormulaInjectionRisk("+81-1234"), "detects leading +");
  assertTrue(detectFormulaInjectionRisk("-100円引き"), "detects leading -");
  assertTrue(detectFormulaInjectionRisk("@mention"), "detects leading @");
  assertTrue(!detectFormulaInjectionRisk("通常の商品名"), "normal text is not flagged");
  const blocked = validateMercariCsvRow(baseFields({ productName: "=cmd" }));
  assertTrue(!blocked.ok, "formula-leading product name is blocked, not silently changed");
}

// --- 11. CSVクオート: カンマ/改行/引用符 ---
function testCsvQuoting() {
  assertEqual(csvQuoteCell("plain"), "plain", "no quoting needed for plain text");
  assertEqual(csvQuoteCell("a,b"), '"a,b"', "comma triggers quoting");
  assertEqual(csvQuoteCell('say "hi"'), '"say ""hi"""', "double quotes are doubled");
  assertEqual(csvQuoteCell("line1\nline2"), '"line1\nline2"', "embedded newline triggers quoting, newline preserved");
}

// --- 12. 独立パーサでの再読込一致 ---
function testIndependentReparse() {
  const header = ["h1", "h2", "h3"];
  const rows = [
    ["a,b", 'c"d', "e\nf"],
    ["普通の日本語", "", "123"],
  ];
  const text = buildCsvText(header, rows);
  const reparsed = parseCsvIndependent(text);
  assertEqual(reparsed, [header, ...rows], "independent parser reconstructs exact original cell values");
}

// --- 13. CP932非対応文字はエンコード段で停止(?置換しない) ---
function testEncodeStopsOnUnrepresentable() {
  const result = encodeMercariCsv(["h1"], [["絵文字😀入り"]]);
  assertTrue(!result.ok, "encoding is blocked when a cell has a CP932-unrepresentable char");
  if (!result.ok) {
    assertEqual(result.errors[0]?.invalidChar, "😀", "encode error reports the exact unrepresentable character");
  }
}

// --- 14. 全体オーケストレーション: 0件/上限/重大エラー時は部分成功させない ---
function testBuildMercariCsvExport() {
  const zero = buildMercariCsvExport([]);
  assertTrue(!zero.ok, "0 selected rows is rejected");

  const oneBad = [baseFields({ inventoryId: "ok-1" }), baseFields({ inventoryId: "bad-1", salePrice: 1 })];
  const mixed = buildMercariCsvExport(oneBad);
  assertTrue(!mixed.ok, "one invalid row blocks the whole export (no silent partial success)");
  assertEqual(mixed.outputCount, 0, "blocked export produces zero output rows");
  assertTrue(mixed.blockedRows.some((r) => r.inventoryId === "bad-1"), "blocked row is identified by inventoryId");

  const allGood = [baseFields({ inventoryId: "ok-1" }), baseFields({ inventoryId: "ok-2", displayId: "B000002" })];
  const success = buildMercariCsvExport(allGood);
  assertTrue(success.ok, "all-valid rows produce a successful export");
  assertEqual(success.outputCount, allGood.length, "output count matches selected count exactly");
  assertTrue(!!success.csv, "csv payload is present on success");
  if (success.csv) {
    const reparsed = parseCsvIndependent(decodeCp932(success.csv.buffer));
    assertEqual(reparsed.length, 1 + allGood.length, "reparsed row count = header + data rows");
    assertEqual(reparsed[0].length, MERCARI_CSV_COLUMN_COUNT, "reparsed header has exactly 88 columns");
    assertTrue(success.csv.text.split("\n").every((line) => !line.includes("\r")), "output uses LF, not CRLF");
  }
}

// --- 15. マスタ: 提供物をdata/mercari-masters/へ実配置した状態での実件数/検索/上限 ---
function testMasters() {
  assertTrue(hasBrandMaster(), "brand master (data/mercari-masters/brand_master.csv) is present and readable");
  assertTrue(hasCategoryMaster(), "category master (data/mercari-masters/category_master.csv) is present and readable");

  const brands = loadBrandMaster();
  const categories = loadCategoryMaster();
  assertTrue(!!brands && brands.length > 50000, "brand master has the expected real row count (>50000)");
  assertTrue(!!categories && categories.length > 7000, "category master has the expected real row count (>7000)");

  // 実データに含まれる既知の1件で往復確認(捏造せず、提供物からそのまま読める値)
  const knownBrand = getBrandById("225nDaWCk4MpMbnFP6a5An");
  assertEqual(knownBrand?.name, "Xmiss", "getBrandById resolves a known real brandId to its name");
  const knownCategory = getCategoryById("iBDxa3BbcUz8XWrr5pgq2Z");
  assertEqual(knownCategory?.fullPath, "CD・DVD・ブルーレイ > CD > K-POP・アジア", "getCategoryById resolves a known real categoryId with its full path");

  assertEqual(getBrandById("does-not-exist"), null, "unknown brandId resolves to null, not fabricated");
  assertEqual(getCategoryById("does-not-exist"), null, "unknown categoryId resolves to null, not fabricated");

  const brandHits = searchBrands("Xmiss");
  assertTrue(brandHits.length >= 1, "searchBrands finds the known brand by exact name");
  assertTrue(brandHits.length <= 50, "searchBrands result is capped at the search limit, not returning all matches");

  // 同名末端カテゴリが複数IDに存在しうる前提の検証: fullPathで区別できること
  const categoryHits = searchCategories("K-POP");
  assertTrue(categoryHits.length >= 1, "searchCategories finds a known category by partial name");
  assertTrue(
    categoryHits.every((c) => c.fullPath.length > 0),
    "every category search result carries its fullPath (caller must not decide by name alone)",
  );
}

// --- 16. buildExportRowForInventoryが実際に組み立てる論理(assembleRow.ts):
// レビュー指摘(2026-09-14)「発送までの日数を意図的な不正値のまま渡している」
// の修正確認。ChannelListing.categoryMapping.mercariShippingDaysが
// MercariCategoryMappingSectionの保存導線経由で入る想定の合成データで、
// (1)未選択ならブロックする、(2)選択済みならCSV生成が最後まで成功する
// ことを検証する(実DB/実ブラウザなしの合成fixture、ただし実際に
// buildExportRowForInventoryが呼ぶのと同じ関数)。
function baseSyntheticInventory(overrides: Partial<CsvSourceInventory> = {}): CsvSourceInventory {
  return { displayId: "B900001", quantity: 1, sku: "B900001", barcode: "4901234567894", ...overrides };
}

function baseSyntheticDraft(overrides: Partial<ListingDraftRecord> = {}): ListingDraftRecord {
  return {
    id: "ld-900001",
    inventoryId: "inv-900001",
    title: "合成テスト用ダイニングチェア",
    description: "合成テスト用の説明文です。",
    price: 12000,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: "KAZAI",
    images: [{ storageKey: "inventory/inv-900001/photo1.jpg", sortOrder: 0 }],
    createdBy: "verify-script",
    updatedBy: "verify-script",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function baseSyntheticChannelListing(overrides: Partial<ChannelListingRecord> = {}): ChannelListingRecord {
  return {
    id: "cl-900001",
    listingDraftId: "ld-900001",
    inventoryId: "inv-900001",
    channel: "MERCARI_SHOPS",
    categoryMapping: {
      mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
      mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
      mercariShippingPayer: 1,
    },
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function testAssembleRowShippingDaysWiring() {
  // カテゴリー確定済み・発送日数「未選択」(旧実装が意図的な不正値0を
  // 渡していた状態と同じ入口) -> ブロックされ、理由に「発送までの日数」
  // という文言が含まれる(黙って既定値を出さない)。
  const withoutShippingDays = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing(),
  );
  assertTrue(!withoutShippingDays.ok, "shippingDays未選択はブロックされる(黙って既定値を出さない)");
  if (!withoutShippingDays.ok) {
    assertTrue(
      withoutShippingDays.reasons.some((r) => r.includes("発送までの日数")),
      "ブロック理由に「発送までの日数」が含まれる",
    );
  }

  // MercariCategoryMappingSectionの「保存」ボタンでmercariShippingDaysが
  // 永続化された後の状態 -> CSV生成が最後まで成功する(ブロックされない)。
  const withShippingDays = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 1,
      },
    }),
  );
  assertTrue(withShippingDays.ok, "カテゴリー確定+発送日数選択+配送料負担選択後はブロックされない");
  if (withShippingDays.ok) {
    assertEqual(withShippingDays.fields.shippingDays, 2, "shippingDaysに選択した実値がそのまま渡る(0等の不正値ではない)");
    const exported = buildMercariCsvExport([withShippingDays.fields]);
    assertTrue(exported.ok, "カテゴリー確定→発送日数選択→配送料負担選択→CSV生成が最後まで成功する(1商品)");
    assertEqual(exported.outputCount, 1, "出力件数が選択件数と一致する");
  }
}

// --- 17. レビュー指摘(2026-09-14)「shippingPayer=1固定」「salePrice=
// Math.trunc」の修正確認。BELLOには送料負担者の既存確認済み運用値が
// 無い(lib/listing/types.ts参照)ため、shippingDaysと同じく未選択は
// ブロックする。価格は丸めず、非整数はvalidate.ts側でブロックさせる。
function testAssembleRowShippingPayerAndPriceWiring() {
  // カテゴリー・発送日数は確定済みだが配送料の負担が未選択 -> ブロック
  // され、理由に「配送料の負担」が含まれる(黙って送料込へ固定しない)。
  const withoutShippingPayer = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
      },
    }),
  );
  assertTrue(!withoutShippingPayer.ok, "shippingPayer未選択はブロックされる(送料込へ黙って固定しない)");
  if (!withoutShippingPayer.ok) {
    assertTrue(
      withoutShippingPayer.reasons.some((r) => r.includes("配送料の負担")),
      "ブロック理由に「配送料の負担」が含まれる",
    );
  }

  // 配送料の負担=送料別(2)を選んだ場合、選んだ実値がそのまま渡る
  // (1固定ではない)。
  const withShippingPayer2 = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 2,
      },
    }),
  );
  assertTrue(withShippingPayer2.ok, "配送料の負担=送料別を選択済みならブロックされない");
  if (withShippingPayer2.ok) {
    assertEqual(withShippingPayer2.fields.shippingPayer, 2, "shippingPayerに選択した実値(2)がそのまま渡る(1固定ではない)");
  }

  // 価格は丸めない——下書きの価格が非整数(何らかの経路で混入した端数)
  // でも、assembleMercariCsvRowFieldsはMath.truncせず生の値をそのまま
  // 渡す。ブロックはvalidate.ts(validateMercariCsvRow)側の責務。
  const fractionalPrice = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft({ price: 1000.5 }),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 1,
      },
    }),
  );
  assertTrue(fractionalPrice.ok, "非整数価格でも組み立て自体はブロックしない(丸めずそのまま渡す)");
  if (fractionalPrice.ok) {
    assertEqual(fractionalPrice.fields.salePrice, 1000.5, "salePriceは丸められず、下書きの値がそのまま渡る(Math.truncされない)");
    const validation = validateMercariCsvRow(fractionalPrice.fields);
    assertTrue(!validation.ok, "非整数salePriceはvalidateMercariCsvRowでブロックされる(黙って丸めて成功させない)");
    const exported = buildMercariCsvExport([fractionalPrice.fields]);
    assertTrue(!exported.ok, "非整数価格の行を含むCSV生成は全体がブロックされる(部分成功させない)");
  }
}

// --- 18. task_ca862bd2a1f6fbf60d(2026-09-15)是正: 送料ID
// (mercariShippingFeeId)の配線確認。e8報告
// (task_e8b97d6b40aad90fff)の残課題——「配送料の負担=送料別を選ぶと
// CSV側は送料ID必須(validate.ts)なのに、入力UI自体が無いため常に
// ブロックされる」——をMercariCategoryMappingSection.tsxへ入力欄を
// 追加して解消した後、assembleRow.tsの配線(mapping→fields)が
// 「送料別の時だけ渡す/送料込では黙って落とす」を正しく行うかを検証する。
function testAssembleRowShippingFeeIdWiring() {
  // 配送料の負担=送料別(2)だが送料IDが未入力 -> assembleRow自体は
  // ブロックしない(必須チェックはvalidate.ts側の責務)が、fields.
  // shippingFeeIdはnullのまま渡る -> validateMercariCsvRow/
  // buildMercariCsvExportがそこでブロックする(黙って空文字で通さない)。
  const payer2WithoutFeeId = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 2,
      },
    }),
  );
  assertTrue(payer2WithoutFeeId.ok, "送料別だが送料ID未入力でも行の組み立て自体はブロックしない(必須チェックはvalidate.ts側)");
  if (payer2WithoutFeeId.ok) {
    assertEqual(payer2WithoutFeeId.fields.shippingFeeId, null, "送料ID未入力ならfields.shippingFeeIdはnull(空文字列で捏造しない)");
    const validation = validateMercariCsvRow(payer2WithoutFeeId.fields);
    assertTrue(!validation.ok, "送料別+送料ID未入力はvalidateMercariCsvRowでブロックされる");
    assertTrue(
      validation.errors.some((e) => e.field === "shippingFeeId"),
      "ブロック理由がshippingFeeIdフィールドを指す",
    );
    const exported = buildMercariCsvExport([payer2WithoutFeeId.fields]);
    assertTrue(!exported.ok, "送料別+送料ID未入力の行を含むCSV生成は全体がブロックされる(部分成功させない)");
  }

  // 配送料の負担=送料別(2)、送料IDを入力・保存済み -> CSV生成が最後まで成功し、
  // 保存した実値がそのままCSVへ載る。
  const payer2WithFeeId = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 2,
        mercariShippingFeeId: "fee-900001",
      },
    }),
  );
  assertTrue(payer2WithFeeId.ok, "送料別+送料ID入力済みなら行の組み立てが成功する");
  if (payer2WithFeeId.ok) {
    assertEqual(payer2WithFeeId.fields.shippingFeeId, "fee-900001", "保存した送料IDの実値がそのままfields.shippingFeeIdへ渡る");
    const exported = buildMercariCsvExport([payer2WithFeeId.fields]);
    assertTrue(exported.ok, "送料別+送料ID入力済みならCSV生成が最後まで成功する");
    assertEqual(mapRowToCells(payer2WithFeeId.fields)[81], "fee-900001", "CSV82列目(配列index 81、shippingFeeId)に送料IDの実値がそのまま出る");
  }

  // 送料込(1)へ戻した後は、mapping側に古い送料IDが残っていてもCSVへは
  // 出さない(指示書§4「送料込への切替ではCSVにIDを出さない」)——
  // MercariCategoryMappingSection.tsxのsaveShippingPayer()は送料込へ
  // 戻す際にmercariShippingFeeId自体は消さない設計(再度送料別へ戻した
  // 時に入力し直させないため)なので、消さなくても漏れないことを
  // assembleRow.ts側の配線で保証する。
  const payer1WithStaleFeeId = assembleMercariCsvRowFields(
    "inv-900001",
    baseSyntheticInventory(),
    baseSyntheticDraft(),
    baseSyntheticChannelListing({
      categoryMapping: {
        mercariCategoryId: "iBDxa3BbcUz8XWrr5pgq2Z",
        mercariCategoryName: "CD・DVD・ブルーレイ > CD > K-POP・アジア",
        mercariShippingDays: 2,
        mercariShippingPayer: 1,
        mercariShippingFeeId: "fee-900001",
      },
    }),
  );
  assertTrue(payer1WithStaleFeeId.ok, "送料込+送料ID残存でも行の組み立ては成功する");
  if (payer1WithStaleFeeId.ok) {
    assertEqual(payer1WithStaleFeeId.fields.shippingFeeId, null, "送料込に戻すと、mappingに送料IDが残っていてもfields.shippingFeeIdはnull(CSVへ漏れない)");
    const validation = validateMercariCsvRow(payer1WithStaleFeeId.fields);
    assertTrue(validation.ok, "送料込では送料ID自体が不要なため、他の必須項目が揃っていればブロックされない");
  }
}

/**
 * imageFilename()はCSVの商品画像名列(assembleRow.ts)と、画像ダウンロード
 * 導線(buildExportRows.ts/imageBundle.ts)の両方が呼ぶ唯一の命名関数。
 * ここで命名規則そのもの({displayId}_{1始まりの連番}{拡張子})を
 * 固定し、実装が黙って変わっても壊れて気づけるようにする——今まで
 * 直接のテストが無かった(境界値テストのみ)。
 */
function testImageFilenameNaming() {
  assertEqual(imageFilename("inventory/abc/photo.jpg", "B000001", 0), "B000001_1.jpg", "1枚目(index 0)は連番1、拡張子はstorageKey由来");
  assertEqual(imageFilename("inventory/abc/photo.PNG", "B000001", 2), "B000001_3.PNG", "3枚目(index 2)は連番3、拡張子の大文字小文字を保持");
  assertEqual(imageFilename("inventory/abc/no-extension-key", "B000001", 0), "B000001_1.jpg", "拡張子が無いstorageKeyは.jpgへ既定される(黙って空拡張子にしない)");
  assertEqual(imageFilename("inventory/abc/a.b.tar.gz", "B000001", 0), "B000001_1.gz", "複数ドットは最後のドット以降だけを拡張子とする");
}

/** buildStoredZip()の独立読み込み検証用の最小限ZIPパーサ(store方式専用、テスト内限定)。 */
function readStoredZipEntries(buffer: Buffer): { filename: string; data: Buffer; crc: number }[] {
  const eocdSig = buffer.readUInt32LE(buffer.length - 22);
  assertEqual(eocdSig, 0x06054b50, "EOCDシグネチャがバッファ末尾22byte目にある(コメント無し前提)");
  const entryCount = buffer.readUInt16LE(buffer.length - 22 + 10);
  const centralDirOffset = buffer.readUInt32LE(buffer.length - 22 + 16);

  const entries: { filename: string; data: Buffer; crc: number }[] = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    assertEqual(buffer.readUInt32LE(cursor), 0x02014b50, `central directory entry ${i} signature`);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const filename = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen;

    assertEqual(buffer.readUInt32LE(localOffset), 0x04034b50, `local file header ${i} signature`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ filename, data: Buffer.from(data), crc });
  }
  return entries;
}

/**
 * ZIP組み立て(imageBundle.tsが使う)のバイト単位往復検証。CSVの
 * decodeCp932→parseCsvIndependent(独立パーサでの再読込検証)と同じ
 * 発想——自前実装のZIPシリアライザを、自前実装のZIPパーサ「以外」の
 * 手作りバイナリ読み取りで検算し、書いたバイトと読めるバイトが本当に
 * 一致するかを確認する。
 */
function testImageZipRoundTrip() {
  const empty = buildStoredZip([]);
  assertTrue(!empty.ok, "0件のZIP組み立ては拒否される(空ZIPを成功として返さない)");

  const entries = [
    { filename: "B000001_1.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]) },
    { filename: "B000001_2.png", data: new Uint8Array(Array.from({ length: 500 }, (_, i) => i % 256)) },
    { filename: "日本語ファイル名_3.jpg", data: new Uint8Array([0, 0, 0]) },
  ];
  const built = buildStoredZip(entries);
  assertTrue(built.ok && !!built.bytes, "3件のZIP組み立ては成功する");
  if (!built.ok || !built.bytes) return;

  const parsed = readStoredZipEntries(Buffer.from(built.bytes));
  assertEqual(parsed.length, entries.length, "ZIP内のエントリ数が投入した画像数と一致する");
  parsed.forEach((p, i) => {
    assertEqual(p.filename, entries[i].filename, `entry ${i}: ファイル名がCSVの商品画像名と同じ値で保存されている`);
    assertEqual(Buffer.from(p.data).equals(Buffer.from(entries[i].data)), true, `entry ${i}: 展開したバイト列が元の画像バイトと完全一致する`);
    assertEqual(p.crc, crc32(entries[i].data), `entry ${i}: CRC-32が実データと一致する(壊れたZIPを検出できる)`);
  });
}

testHeader();
testMasters();
testAssembleRowShippingDaysWiring();
testAssembleRowShippingPayerAndPriceWiring();
testAssembleRowShippingFeeIdWiring();
testCp932RoundTrip();
testUnicodeLength();
testTitleDescriptionBoundaries();
testPriceBounds();
testQuantity();
testManagementAndJanCode();
testCategoryAndShipping();
testImages();
testImageFilenameNaming();
testImageZipRoundTrip();
testFormulaInjection();
testCsvQuoting();
testIndependentReparse();
testEncodeStopsOnUnrepresentable();
testBuildMercariCsvExport();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
