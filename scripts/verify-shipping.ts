/**
 * BELLO統合業務OS指示書(2026-08-30) §61-69: 家財おまかせ便の純粋ロジック
 * (lib/shipping/rank.ts)のstandalone verification —
 * scripts/verify-messaging.tsと同じ方針(no test framework installed)。
 *
 * Run with: npm run verify:shipping
 */
import { calculateShippingRankFromSum, calculateShippingRankFromDimensions, parseDimensionCm, SHIPPING_RANKS } from "@/lib/shipping/rank";
import { calculateMedian, pickLatestPerPrefecture, buildShippingReferencePriceView, MIN_DISTINCT_REGIONS_FOR_MEDIAN, REGION_DIFFERENCE_THRESHOLD_YEN } from "@/lib/shipping/referencePrice";
import type { ShippingRateRecord } from "@/lib/shipping/types";

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

function testCalculateShippingRankFromSum() {
  // §63の9段階の閾値そのもの(境界値を正確に検証する)。
  assertEqual(calculateShippingRankFromSum(80), "SS", "rank: sum=80 (SS上限) -> SS");
  assertEqual(calculateShippingRankFromSum(80.1), "S", "rank: sum=80.1 (SS上限超え) -> S");
  assertEqual(calculateShippingRankFromSum(120), "S", "rank: sum=120 (S上限) -> S");
  assertEqual(calculateShippingRankFromSum(160), "A", "rank: sum=160 (A上限) -> A");
  assertEqual(calculateShippingRankFromSum(200), "B", "rank: sum=200 (B上限、実例: 埼玉→東京チェスト¥4,510) -> B");
  assertEqual(calculateShippingRankFromSum(250), "C", "rank: sum=250 (C上限、実例: 埼玉→東京1人掛けソファー¥7,740) -> C");
  assertEqual(calculateShippingRankFromSum(300), "D", "rank: sum=300 (D上限) -> D");
  assertEqual(calculateShippingRankFromSum(350), "E", "rank: sum=350 (E上限) -> E");
  assertEqual(calculateShippingRankFromSum(400), "F", "rank: sum=400 (F上限) -> F");
  assertEqual(calculateShippingRankFromSum(450), "G", "rank: sum=450 (G上限) -> G");
  assertEqual(calculateShippingRankFromSum(450.01), "OVERSIZE", "rank: sum=450.01 (G上限超え) -> OVERSIZE(規格外候補)");
  assertEqual(calculateShippingRankFromSum(1000), "OVERSIZE", "rank: 大幅に超過 -> OVERSIZE");
  assertEqual(calculateShippingRankFromSum(1), "SS", "rank: 最小サイズ -> SS");

  let threw = false;
  try {
    calculateShippingRankFromSum(0);
  } catch {
    threw = true;
  }
  assertTrue(threw, "rank: sum=0以下は契約違反としてthrowする(黙ってSS等を返さない)");

  threw = false;
  try {
    calculateShippingRankFromSum(-10);
  } catch {
    threw = true;
  }
  assertTrue(threw, "rank: 負の合計もthrowする");

  assertEqual(SHIPPING_RANKS.length, 10, "SHIPPING_RANKS: 9段階+OVERSIZEの10件");
}

function testParseDimensionCm() {
  assertEqual(parseDimensionCm("50"), 50, "parseDimensionCm: 数字のみ");
  assertEqual(parseDimensionCm("50cm"), 50, "parseDimensionCm: 単位付き");
  assertEqual(parseDimensionCm("50.5"), 50.5, "parseDimensionCm: 小数");
  assertEqual(parseDimensionCm("約50cm程度"), 50, "parseDimensionCm: 前後に日本語が付いていても数値部分を抜き出す");
  assertEqual(parseDimensionCm("５０"), 50, "parseDimensionCm: 全角数字も正規化する");
  assertEqual(parseDimensionCm(null), null, "parseDimensionCm: null -> null(不明)");
  assertEqual(parseDimensionCm(""), null, "parseDimensionCm: 空文字 -> null");
  assertEqual(parseDimensionCm("不明"), null, "parseDimensionCm: 数値が全く無い -> null");
  assertEqual(parseDimensionCm("0"), null, "parseDimensionCm: 0以下は「不明」扱い(サイズ0の家具は無い)");
  // 寸法にマイナス記号が付くことは実運用上あり得ないため、符号は数値
  // 抽出の対象外(正規表現が符号を拾わない結果、"-5"は5cmとして扱われる)。
  assertEqual(parseDimensionCm("-5"), 5, "parseDimensionCm: マイナス記号は数値部分に含めない(符号なしの5として扱う)");
}

function testCalculateShippingRankFromDimensions() {
  const result = calculateShippingRankFromDimensions("50", "60", "90");
  assertEqual(result?.sumCm, 200, "dimensions: 50+60+90=200のsumCm");
  assertEqual(result?.rank, "B", "dimensions: 200cm -> Bランク(実例と一致)");

  assertEqual(calculateShippingRankFromDimensions(null, "60", "90"), null, "dimensions: 幅が不明なら判定不能(null)");
  assertEqual(calculateShippingRankFromDimensions("50", "", "90"), null, "dimensions: 奥行が空文字でも判定不能(null)");
  assertEqual(calculateShippingRankFromDimensions("不明", "不明", "不明"), null, "dimensions: 3つとも数値が読み取れない -> null");

  const oversized = calculateShippingRankFromDimensions("200", "200", "200");
  assertEqual(oversized?.sumCm, 600, "dimensions: 大型家具の合計値");
  assertEqual(oversized?.rank, "OVERSIZE", "dimensions: 600cm -> 規格外候補");
}

function makeRate(overrides: Partial<ShippingRateRecord> = {}): ShippingRateRecord {
  return {
    id: `rate-${Math.random()}`,
    provider: "アートセッティングデリバリー",
    service: "家財おまかせ便",
    originPrefecture: "埼玉県",
    originArea: null,
    destinationPrefecture: "東京都",
    destinationArea: null,
    rank: "B",
    price: 4510,
    surcharge: null,
    effectiveFrom: null,
    effectiveTo: null,
    sourceReference: "test",
    verifiedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** BELLO ZAICO級高速化・完成保証最大化版 §31/§46: 送料込み参考価格のテスト。 */
function testCalculateMedian() {
  assertEqual(calculateMedian([100]), 100, "median: 1件のみ");
  assertEqual(calculateMedian([100, 200, 300]), 200, "median: 奇数件は中央の1値");
  assertEqual(calculateMedian([100, 200, 300, 400]), 250, "median: 偶数件は中央2値の算術平均(100+400ではなく200/300ペア)");
  // calculateMedianは「昇順ソート済み配列」を受け取る契約(関数コメント
  // 参照) — 呼び出し元(buildShippingReferencePriceView)が必ず
  // `.sort((a,b)=>a-b)`してから渡す。ここでは契約通りソート済みを渡す
  // ことを明示するテストにする(ソートしない誤用は別の問題)。
  assertEqual(calculateMedian([100, 200, 300].sort((a, b) => a - b)), 200, "median: 呼び出し元がソート済み配列を渡す契約を守れば正しい値になる");
}

function testPickLatestPerPrefecture() {
  const rates = [
    makeRate({ id: "old", destinationPrefecture: "東京都", version: 1, effectiveFrom: "2026-01-01" }),
    makeRate({ id: "new", destinationPrefecture: "東京都", version: 2, effectiveFrom: "2026-06-01" }),
    makeRate({ id: "osaka", destinationPrefecture: "大阪府", version: 1 }),
  ];
  const picked = pickLatestPerPrefecture(rates);
  assertEqual(picked.length, 2, "pickLatestPerPrefecture: 都道府県ごとに1件へ絞り込む");
  assertTrue(
    picked.some((r) => r.id === "new"),
    "pickLatestPerPrefecture: 同一都道府県では新しいeffectiveFromの行を採用する",
  );
}

function testShippingReferencePriceInsufficientData() {
  const view = buildShippingReferencePriceView({
    plannedPrice: 30000,
    rank: "B",
    verifiedRates: [makeRate({ destinationPrefecture: "東京都" }), makeRate({ destinationPrefecture: "大阪府", price: 5000 })],
  });
  assertEqual(view.status, "INSUFFICIENT_DATA", `検証済み地域が${MIN_DISTINCT_REGIONS_FOR_MEDIAN}未満(2件)なら中央値を出さずデータ不足を返す`);
  if (view.status === "INSUFFICIENT_DATA") {
    assertEqual(view.availableRegionCount, 2, "データ不足: 現在の検証済み地域数を返す");
  }
}

function testShippingReferencePriceOk() {
  const verifiedRates = [
    makeRate({ destinationPrefecture: "東京都", price: 4510 }),
    makeRate({ destinationPrefecture: "愛知県", price: 5000 }),
    makeRate({ destinationPrefecture: "大阪府", price: 6800 }), // 中央値との差が2000円以上想定
    makeRate({ destinationPrefecture: "北海道", price: 9000 }), // 明確に外れ値
  ];
  const view = buildShippingReferencePriceView({ plannedPrice: 30000, rank: "B", verifiedRates });
  assertEqual(view.status, "OK", "4地域の検証済みデータがあれば中央値を算出する");
  if (view.status !== "OK") return;

  const sorted = [4510, 5000, 6800, 9000];
  const expectedMedian = Math.round((sorted[1] + sorted[2]) / 2); // 5900
  assertEqual(view.medianShipping, expectedMedian, "送料中央値: 偶数件の算術平均");
  assertEqual(view.referenceTotal, 30000 + expectedMedian, "referenceTotal = plannedPrice + medianShipping");
  assertEqual(view.plannedPrice, 30000, "plannedPriceは入力値のまま(書き換えない)");

  assertEqual(view.representativeRegions.length, 3, "代表地域は東京・名古屋圏・大阪圏の3件");
  const tokyo = view.representativeRegions.find((r) => r.label === "東京");
  assertTrue(tokyo != null && !("status" in tokyo), "東京はデータありなので通常行");
  const nagoya = view.representativeRegions.find((r) => r.label === "名古屋圏");
  assertTrue(nagoya != null && !("status" in nagoya) && nagoya.prefecture === "愛知県", "名古屋圏は愛知県を代表値として使う");

  // 北海道(9000円)は中央値5900円との差が3100円 >= 2000円なので追加表示対象。
  assertTrue(
    view.notableDifferenceRegions.some((r) => r.label === "北海道"),
    "中央値との差額が2000円以上の地域(北海道)が追加表示される",
  );
  // 大阪府は代表地域として既に表示されているので、notableDifferenceRegionsには重複させない。
  assertTrue(
    !view.notableDifferenceRegions.some((r) => r.prefecture === "大阪府"),
    "代表地域として既に表示された都道府県は追加表示に重複させない",
  );
}

function testShippingReferencePriceNoFakeGuess() {
  // 差額がしきい値未満(1999円)の地域は追加表示されない——このテストは
  // REGION_DIFFERENCE_THRESHOLD_YEN自体の値を直接使うことで、しきい値
  // が変更されても意図を保ったまま追随する。
  const verifiedRates = [
    makeRate({ destinationPrefecture: "東京都", price: 5000 }),
    makeRate({ destinationPrefecture: "愛知県", price: 5000 }),
    makeRate({ destinationPrefecture: "大阪府", price: 5000 }),
    makeRate({ destinationPrefecture: "福岡県", price: 5000 + REGION_DIFFERENCE_THRESHOLD_YEN - 1 }),
  ];
  const view = buildShippingReferencePriceView({ plannedPrice: 10000, rank: "C", verifiedRates });
  assertEqual(view.status, "OK", "4地域あるので算出できる");
  if (view.status !== "OK") return;
  assertTrue(!view.notableDifferenceRegions.some((r) => r.label.includes("福岡")), "差額がしきい値未満の地域は追加表示されない(推測で目立たせない)");
}

function main() {
  testCalculateShippingRankFromSum();
  testParseDimensionCm();
  testCalculateShippingRankFromDimensions();
  testCalculateMedian();
  testPickLatestPerPrefecture();
  testShippingReferencePriceInsufficientData();
  testShippingReferencePriceOk();
  testShippingReferencePriceNoFakeGuess();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
