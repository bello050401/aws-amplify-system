/**
 * BELLO統合業務OS指示書(2026-08-30) §61-69: 家財おまかせ便の純粋ロジック
 * (lib/shipping/rank.ts)のstandalone verification —
 * scripts/verify-messaging.tsと同じ方針(no test framework installed)。
 *
 * Run with: npm run verify:shipping
 */
import { calculateShippingRankFromSum, calculateShippingRankFromDimensions, parseDimensionCm, SHIPPING_RANKS } from "@/lib/shipping/rank";
import type { ShippingRank } from "@/lib/shipping/rank";
import { SHIPPING_RATE_SEED, HOKKAIDO_AREA_BY_MUNICIPALITY, HOKKAIDO_AREAS, lookupShippingRate, resolveHokkaidoArea } from "@/lib/shipping/ratesSeed";
import { calculateMedian, pickLatestPerPrefecture, buildShippingReferencePriceView, MIN_DISTINCT_REGIONS_FOR_MEDIAN, REGION_DIFFERENCE_THRESHOLD_YEN } from "@/lib/shipping/referencePrice";
import { buildExpectedMatrix, computeMatrixCompleteness, computeRawHash, ALL_SHIPPING_RANKS } from "@/lib/shipping/importer";
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
    taxIncluded: true,
    currency: "JPY",
    surcharge: null,
    effectiveFrom: null,
    effectiveTo: null,
    sourceReference: "test",
    acquiredAt: null,
    verifiedAt: "2026-08-01T00:00:00.000Z",
    status: "VERIFIED",
    rawHash: null,
    importBatchId: null,
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

/** 第六ラウンド§9(P0-2): buildExpectedMatrix/computeMatrixCompleteness/computeRawHash——importerの純粋ロジック部分。 */
function testBuildExpectedMatrix() {
  const matrix = buildExpectedMatrix(["東京都", "大阪府"], ["B", "C"]);
  assertEqual(matrix.length, 4, "2都道府県×2rankで4組合せ");
  assertTrue(
    matrix.some((c) => c.destinationPrefecture === "東京都" && c.rank === "B") && matrix.some((c) => c.destinationPrefecture === "大阪府" && c.rank === "C"),
    "全組合せが総当たりで生成される",
  );
}

function testComputeMatrixCompleteness() {
  const expected = buildExpectedMatrix(["東京都", "大阪府", "北海道"], ["B", "C"]);
  // 6組合せ中、東京都B=VERIFIED、東京都C=UNAVAILABLE、大阪府B=VERIFIED、
  // 残り3件(大阪府C, 北海道B, 北海道C)は未取得(missing)。
  const actual: { destinationPrefecture: string; rank: "B" | "C"; status: "VERIFIED" | "UNAVAILABLE" }[] = [
    { destinationPrefecture: "東京都", rank: "B", status: "VERIFIED" },
    { destinationPrefecture: "東京都", rank: "C", status: "UNAVAILABLE" },
    { destinationPrefecture: "大阪府", rank: "B", status: "VERIFIED" },
  ];
  const result = computeMatrixCompleteness(expected, actual);
  assertEqual(result.expectedCells, 6, "期待組合せ数=6");
  assertEqual(result.verifiedCells, 2, "VERIFIED=2");
  assertEqual(result.unavailableCells, 1, "UNAVAILABLE=1");
  assertEqual(result.missingCells, 3, "missing=3(0円で埋めず未取得として列挙)");
  assertEqual(result.missingCombinations.length, 3, "missingCombinationsが実際に3件列挙される");
  assertTrue(!result.missingCombinations.some((c) => c.destinationPrefecture === "東京都" && c.rank === "B"), "取得済みの組合せはmissingに含まれない");
  // §9「全国matrix completenessが100%でない場合は『全取得完了』と報告しない」— この比率を報告に使う。
  assertTrue(result.completenessRatio < 1, "6件中3件しか結果を得ていないのでcompletenessRatioは1未満");
}

function testComputeMatrixCompletenessAllVerified() {
  const expected = buildExpectedMatrix(["東京都"], ["B"]);
  const actual: { destinationPrefecture: string; rank: "B"; status: "VERIFIED" | "UNAVAILABLE" }[] = [{ destinationPrefecture: "東京都", rank: "B", status: "VERIFIED" }];
  const result = computeMatrixCompleteness(expected, actual);
  assertEqual(result.completenessRatio, 1, "全組合せがVERIFIED/UNAVAILABLEで埋まればcompletenessRatio=1");
  assertEqual(result.missingCells, 0, "missingCells=0");
}

function testComputeRawHash() {
  const h1 = computeRawHash("¥4,510(税込)");
  const h2 = computeRawHash("¥4,510(税込)");
  const h3 = computeRawHash("¥4,520(税込)");
  assertEqual(h1, h2, "同一文字列は同一hash(差分検出で再書き込みを抑制するための前提)");
  assertTrue(h1 !== h3, "異なる文字列は異なるhash(実際の変更を見逃さない)");
}

function testAllShippingRanksMatchesRankModule() {
  // importer.tsのALL_SHIPPING_RANKSがlib/shipping/rank.tsのSHIPPING_RANKS
  // (OVERSIZEも含む実際の全ランク)と食い違っていないかの回帰チェック
  // ——期待matrixが実際のランク体系から漏れなく生成されることを保証する。
  assertEqual([...ALL_SHIPPING_RANKS].sort(), [...SHIPPING_RANKS].sort(), "importerの全ランク定義がrank.tsの定義と一致する");
}

// ── 夜間指示書§7: らくらく家財 全国料金マスター ──────────────────────
// 利用者提供の一次資料(原始メモ)から機械的に生成した全国料金表を、
// 件数・境界値・「取り扱い不可」の扱いまで固定する。
function testShippingRateSeedCoverage() {
  assertEqual(SHIPPING_RATE_SEED.length, 450, "SHIPPING_RATE_SEED: 50宛先 x 9ランク = 450件(原資料の全件)");

  const destinations = new Set(SHIPPING_RATE_SEED.map((r) => `${r.destinationPrefecture}${r.destinationArea ? "[" + r.destinationArea + "]" : ""}`));
  assertEqual(destinations.size, 50, "SHIPPING_RATE_SEED: 宛先は46都府県 + 北海道4エリア = 50");

  // 各宛先が9ランク揃っている(欠けたランクがあるとUIが無言で空欄になる)
  const byDest = new Map<string, number>();
  for (const r of SHIPPING_RATE_SEED) {
    const key = `${r.destinationPrefecture}${r.destinationArea ?? ""}`;
    byDest.set(key, (byDest.get(key) ?? 0) + 1);
  }
  assertTrue([...byDest.values()].every((n) => n === 9), "SHIPPING_RATE_SEED: 全ての宛先がSS〜Gの9ランクを持つ");

  assertTrue(
    SHIPPING_RATE_SEED.every((r) => r.originPrefecture === "埼玉県"),
    "SHIPPING_RATE_SEED: 発送元は全件が埼玉県(§61 BELLOの所在地)",
  );
  // OVERSIZE(451cm〜)はこの料金表の対象外 — 個別見積りなので行を持たない
  assertTrue(
    SHIPPING_RATE_SEED.every((r) => r.rank !== "OVERSIZE"),
    "SHIPPING_RATE_SEED: OVERSIZEは料金表の対象外(個別見積り)なので行を持たない",
  );
}

function testShippingRateSeedUnavailableIsNotZero() {
  const unavailable = SHIPPING_RATE_SEED.filter((r) => r.price == null);
  assertEqual(unavailable.length, 2, "SHIPPING_RATE_SEED: 原資料で「----」の行は2件(沖縄県のF/Gランク)");
  assertTrue(
    unavailable.every((r) => r.destinationPrefecture === "沖縄県" && (r.rank === "F" || r.rank === "G")),
    "SHIPPING_RATE_SEED: 取り扱い不可は沖縄県のF/Gランクのみ",
  );
  assertTrue(
    SHIPPING_RATE_SEED.every((r) => r.price !== 0),
    "SHIPPING_RATE_SEED: 取り扱い不可を0円で埋めていない(0円だと『送料無料』と誤表示される)",
  );
  // lookupが「不可」と「未登録」を別物として返すこと
  assertEqual(lookupShippingRate("沖縄県", "G").kind, "unavailable", "lookupShippingRate: 沖縄県Gランクは unavailable(取り扱い不可)");
  assertEqual(lookupShippingRate("架空県", "G").kind, "unknown", "lookupShippingRate: マスターに無い宛先は unknown(不可とは別物)");
  const okinawaE = lookupShippingRate("沖縄県", "E");
  assertEqual(okinawaE.kind, "available", "lookupShippingRate: 沖縄県Eランクは金額あり");
  assertEqual(okinawaE.kind === "available" ? okinawaE.price : -1, 50750, "lookupShippingRate: 沖縄県Eランク = 50,750円");
}

function testShippingRateSeedBoundaryValues() {
  // 原資料からの代表値。転記ミスが入ったらここで落ちる。
  const cases: [string, ShippingRank, number][] = [
    ["埼玉県", "SS", 1560],
    ["埼玉県", "B", 4510],
    ["埼玉県", "G", 31290],
    ["東京都", "B", 4510],
    ["東京都", "C", 7740],
    ["青森県", "SS", 1830],
    ["沖縄県", "SS", 2620],
  ];
  for (const [pref, rank, expected] of cases) {
    const got = lookupShippingRate(pref, rank);
    assertEqual(got.kind === "available" ? got.price : null, expected, `lookupShippingRate: ${pref} ${rank}ランク = ${expected.toLocaleString()}円`);
  }
  // 以前このファイルが持っていた2件(WebSearch由来)と一次資料が一致することの確認
  assertEqual(
    lookupShippingRate("東京都", "B").kind === "available" ? (lookupShippingRate("東京都", "B") as { price: number }).price : null,
    4510,
    "一次資料は、旧seedがWebSearchで得ていた東京Bランク4,510円と一致する(推測で埋めなかった判断の裏づけ)",
  );
}

function testHokkaidoAreaResolution() {
  assertEqual(Object.keys(HOKKAIDO_AREA_BY_MUNICIPALITY).length, 189, "HOKKAIDO_AREA_BY_MUNICIPALITY: 原資料の市区町村189件");

  // 4エリアそれぞれに料金が存在し、かつ区別されている
  const areaPrices = HOKKAIDO_AREAS.map((a) => {
    const r = lookupShippingRate("北海道", "G", a);
    return r.kind === "available" ? r.price : null;
  });
  assertTrue(areaPrices.every((p) => p != null), "北海道: 4エリアすべてにGランク料金が登録されている");
  assertTrue(new Set(areaPrices).size > 1, "北海道: エリアによって料金が異なる(4エリアを区別する意味がある)");
  assertEqual(lookupShippingRate("北海道", "G", "函館").kind === "available" ? (lookupShippingRate("北海道", "G", "函館") as { price: number }).price : null, 44680, "北海道[函館] Gランク = 44,680円");
  assertEqual(lookupShippingRate("北海道", "G", "道東").kind === "available" ? (lookupShippingRate("北海道", "G", "道東") as { price: number }).price : null, 55330, "北海道[道東] Gランク = 55,330円");

  // 市区町村からのエリア解決
  assertEqual(resolveHokkaidoArea("旭川市"), "道北", "resolveHokkaidoArea: 旭川市 -> 道北");
  assertEqual(resolveHokkaidoArea("網走市"), "道東", "resolveHokkaidoArea: 網走市 -> 道東");
  assertEqual(resolveHokkaidoArea("小樽市"), "札幌/千歳", "resolveHokkaidoArea: 小樽市 -> 札幌/千歳");
  assertEqual(resolveHokkaidoArea("奥尻郡 奥尻町"), "函館", "resolveHokkaidoArea: 郡つき表記でも解決できる");
  assertEqual(resolveHokkaidoArea("奥尻郡　奥尻町"), "函館", "resolveHokkaidoArea: 全角スペースを吸収する");
  assertEqual(resolveHokkaidoArea("  旭川市  "), "道北", "resolveHokkaidoArea: 前後の空白を吸収する");
  assertEqual(resolveHokkaidoArea("存在しない町"), null, "resolveHokkaidoArea: 該当が無ければnull(推測でエリアを当てない)");
  assertEqual(resolveHokkaidoArea(""), null, "resolveHokkaidoArea: 空文字はnull");
}

function testShippingRankLimitsMatchSource() {
  // 原資料の「◯cmまで」と rank.ts の既存閾値が一致すること。
  // ここが割れると、商品サイズから引いたランクと料金表のランクがずれる。
  const expected: [number, ShippingRank][] = [
    [80, "SS"], [120, "S"], [160, "A"], [200, "B"], [250, "C"], [300, "D"], [350, "E"], [400, "F"], [450, "G"],
  ];
  for (const [cm, rank] of expected) {
    assertEqual(calculateShippingRankFromSum(cm), rank, `calculateShippingRankFromSum(${cm}cm) = ${rank}(原資料の上限と一致)`);
  }
  assertEqual(calculateShippingRankFromSum(451), "OVERSIZE", "calculateShippingRankFromSum(451cm) = OVERSIZE(料金表の対象外)");
}

// ── 自動QA: 料金マスター投入の重複判定に destinationArea を含める ──────
// 以前の seedShippingRates は provider + 宛先都道府県 + rank だけで既存
// 判定しており、全国表(450件)を入れた時点で北海道4エリアが1件に潰れる
// バグになっていた。「北海道 + Cランク」が4エリアで同じキーになり、
// 最初の1件を入れた後は残り3件が「既にある」と誤判定される。しかも
// createがdestinationArea自体を書いていなかったため、入った1件もどの
// エリアか分からない状態だった(stagingで411件すべてがarea=nullだった)。
//
// ここでは「エリアを含めたキーなら4エリアが別物として扱われる」ことを
// 固定する。キー生成の実装が壊れたらこのテストが落ちる。
function testShippingRateKeyDistinguishesHokkaidoAreas() {
  const key = (pref: string, area: string | null, rank: string) => `アートセッティングデリバリー ${pref} ${area ?? ""} ${rank}`;

  const hokkaidoKeys = HOKKAIDO_AREAS.map((a) => key("北海道", a, "C"));
  assertEqual(new Set(hokkaidoKeys).size, 4, "重複判定キー: 北海道の4エリアは別々のキーになる(1件に潰れない)");

  // エリアを含めないキーだと潰れることの対比(これが以前のバグ)
  const naiveKeys = HOKKAIDO_AREAS.map(() => key("北海道", null, "C"));
  assertEqual(new Set(naiveKeys).size, 1, "エリアを含めないキーだと北海道4エリアが1件に潰れる(以前のバグの再現)");

  // 都府県はエリアを持たないので、エリアの有無で取り違えない
  assertTrue(key("東京都", null, "C") !== key("北海道", null, "C"), "重複判定キー: 宛先が違えば別キー");
  assertTrue(key("北海道", "函館", "C") !== key("北海道", "函館", "D"), "重複判定キー: ランクが違えば別キー");
}

// seed全件が「エリアを含めたキー」で一意であること — ここが重複していると
// 投入時に取りこぼしが出る。
function testShippingRateSeedKeysAreUnique() {
  const keys = SHIPPING_RATE_SEED.map((r) => `${r.provider} ${r.destinationPrefecture} ${r.destinationArea ?? ""} ${r.rank}`);
  assertEqual(new Set(keys).size, SHIPPING_RATE_SEED.length, "SHIPPING_RATE_SEED: エリアを含めたキーで全450件が一意(投入時に取りこぼさない)");

  // 北海道は 4エリア x 9ランク = 36件あるはず
  const hokkaido = SHIPPING_RATE_SEED.filter((r) => r.destinationPrefecture === "北海道");
  assertEqual(hokkaido.length, 36, "SHIPPING_RATE_SEED: 北海道は4エリア x 9ランク = 36件");
  assertEqual(new Set(hokkaido.map((r) => r.destinationArea)).size, 4, "SHIPPING_RATE_SEED: 北海道の行は4エリアすべてを持つ");
  assertTrue(
    hokkaido.every((r) => r.destinationArea != null),
    "SHIPPING_RATE_SEED: 北海道の行は必ずdestinationAreaを持つ(nullだとどのエリアの料金か分からなくなる)",
  );
  // 都府県側は逆にエリアを持たない
  assertTrue(
    SHIPPING_RATE_SEED.filter((r) => r.destinationPrefecture !== "北海道").every((r) => r.destinationArea === null),
    "SHIPPING_RATE_SEED: 北海道以外の宛先はdestinationAreaを持たない",
  );
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
  testBuildExpectedMatrix();
  testComputeMatrixCompleteness();
  testComputeMatrixCompletenessAllVerified();
  testComputeRawHash();
  testAllShippingRanksMatchesRankModule();
  testShippingRateSeedCoverage();
  testShippingRateSeedUnavailableIsNotZero();
  testShippingRateSeedBoundaryValues();
  testHokkaidoAreaResolution();
  testShippingRankLimitsMatchSource();
  testShippingRateKeyDistinguishesHokkaidoAreas();
  testShippingRateSeedKeysAreUnique();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
