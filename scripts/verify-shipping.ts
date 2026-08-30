/**
 * BELLO統合業務OS指示書(2026-08-30) §61-69: 家財おまかせ便の純粋ロジック
 * (lib/shipping/rank.ts)のstandalone verification —
 * scripts/verify-messaging.tsと同じ方針(no test framework installed)。
 *
 * Run with: npm run verify:shipping
 */
import { calculateShippingRankFromSum, calculateShippingRankFromDimensions, parseDimensionCm, SHIPPING_RANKS } from "@/lib/shipping/rank";

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

function main() {
  testCalculateShippingRankFromSum();
  testParseDimensionCm();
  testCalculateShippingRankFromDimensions();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
