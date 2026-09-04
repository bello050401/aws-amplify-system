/**
 * 2026-09-04 EC出品改修指示書 §26: 商品説明生成のルールベース領域の回帰。
 *
 *   npm run verify:listing-description
 *
 * **ネットワークにもAWSにも繋がない。** 対象は
 *   ・佐川急便のサイズ判定(lib/shipping/sagawaSize.ts) — 全境界値
 *   ・座面寸法の読み取り(lib/inventory/seatDimensions.ts)
 *   ・メンテナンスの判定(lib/inventory/maintenance.ts)
 *   ・各セクションの組み立て(lib/ai/productPage/descriptionSections.ts)
 *   ・Product Contextの組み立て(lib/ai/productPage/listingFacts.ts)
 *   ・チャネル別formatter(lib/listing/descriptionFormat.ts)
 *
 * ── なぜここを固定するのか ──────────────────────────────────────
 *
 * §28「AIに全部考えさせるのではなく、在庫データから確定できる事実を
 * システム側で確定する」。確定させた以上、その確定が正しいことは
 * 機械的に確かめられなければ意味が無い。特に佐川のサイズ区分は
 * **+20cmしてから切り上げる**という2段階で、境界を1つ間違えると
 * 実際の送料と食い違う。指示書§26が挙げた境界値をそのまま入れてある。
 */
import {
  resolveSagawaSize,
  resolveSagawaSizeFromCm,
  sagawaSizeClassForSum,
  SAGAWA_PACKING_ALLOWANCE_CM,
  formatSagawaSize,
} from "@/lib/shipping/sagawaSize";
import {
  formatSeatDimensionsLine,
  parseSeatDimensionsText,
  resolveSeatDimensions,
} from "@/lib/inventory/seatDimensions";
import { detectMaintenance, looksNonFabric, stripMaintenanceOnlyLines } from "@/lib/inventory/maintenance";
import {
  buildConditionSection,
  buildProductDetailSection,
  buildShippingSection,
  composeListingDescription,
  CONDITION_CLOSING,
  COMMON_NOTICES,
  GOOD_CONDITION_SENTENCE,
  HOLD_POLICY_BODY,
  POLISH_COATING_SENTENCE,
  POLISH_SENTENCE,
  COATING_ONLY_SENTENCE,
  CLEANING_SENTENCE,
  RETURN_POLICY_BODY,
  RINSER_SENTENCE,
  SHIPPING_UNDETERMINED_MARKER,
} from "@/lib/ai/productPage/descriptionSections";
import { buildListingFacts, hasGoodConditionEvidence } from "@/lib/ai/productPage/listingFacts";
import { formatDescriptionForChannel, normalizeDescription } from "@/lib/listing/descriptionFormat";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    期待: ${e}\n    実際: ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

/* ══════════════════════════════════════════════════════════════════
 * §9/§26 佐川急便のサイズ判定 — 境界値
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 指示書§26の表をそのまま。**すでに +20cm した後の判定値**で確かめる。
 * 261以降は判定不可(null)。
 */
const SAGAWA_BOUNDARIES: [number, number | null][] = [
  [59, 60],
  [60, 60],
  [61, 80],
  [79, 80],
  [80, 80],
  [81, 100],
  [99, 100],
  [100, 100],
  [101, 140],
  [139, 140],
  [140, 140],
  [141, 160],
  [159, 160],
  [160, 160],
  [161, 170],
  [170, 170],
  [171, 180],
  [180, 180],
  [181, 200],
  [200, 200],
  [201, 220],
  [220, 220],
  [221, 240],
  [240, 240],
  [241, 260],
  [260, 260],
  [261, null],
];

function testSagawaBoundaries() {
  for (const [judged, expected] of SAGAWA_BOUNDARIES) {
    assertEqual(sagawaSizeClassForSum(judged)?.size ?? null, expected, `§26 佐川: 判定値${judged} → ${expected ?? "判定不可"}`);
  }
  // 「150サイズ」のような区分を作らない。
  assertTrue(
    SAGAWA_BOUNDARIES.every(([, size]) => size === null || [60, 80, 100, 140, 160, 170, 180, 200, 220, 240, 260].includes(size)),
    "§9 存在しないサイズ区分を作らない",
  );
}

function testSagawaPackingAllowance() {
  assertEqual(SAGAWA_PACKING_ALLOWANCE_CM, 20, "§9 梱包余裕分は20cm");
  // §9-1 の例そのまま: 幅60 奥行40 高さ30 → 130 → +20 → 150 → 160サイズ。
  const r = resolveSagawaSizeFromCm({ widthCm: 60, depthCm: 40, heightCm: 30 });
  assertEqual(r.productSumCm, 130, "§9-1 商品の3辺合計は130cm");
  assertEqual(r.judgedSumCm, 150, "§9-1 判定値は150cm(梱包余裕+20)");
  assertEqual(r.sizeClass?.size, 160, "§9-1 判定は160サイズ(150サイズを作らない)");
  assertEqual(formatSagawaSize(r), "飛脚宅配便160サイズ", "§9-1 表記は飛脚宅配便160サイズ");

  // 商品の3辺合計をそのまま使っていないこと。使っていれば140サイズになる。
  assertTrue(r.sizeClass?.size !== 140, "§9 商品の3辺合計をそのまま区分に使わない");
}

function testSagawaLargeService() {
  const r = resolveSagawaSizeFromCm({ widthCm: 70, depthCm: 60, heightCm: 40 }); // 170 + 20 = 190 → 200
  assertEqual(r.sizeClass?.size, 200, "飛脚ラージ: 判定値190 → 200サイズ");
  assertEqual(formatSagawaSize(r), "飛脚ラージサイズ宅配便200サイズ", "170以上はラージサイズ宅配便として表記する");
}

function testSagawaWeight() {
  // 寸法では60サイズだが、重量8kgなら100サイズ(重量上限10kg)。
  const heavy = resolveSagawaSizeFromCm({ widthCm: 15, depthCm: 15, heightCm: 10, weightKg: 8 });
  assertEqual(heavy.sizeClass?.size, 100, "§26 重量が寸法より大きい区分を要求するとき、重量側を採る");
  assertTrue(heavy.note.includes("重量8kg"), "重量で区分が上がったことを説明に残す");

  const light = resolveSagawaSizeFromCm({ widthCm: 15, depthCm: 15, heightCm: 10, weightKg: 1 });
  assertEqual(light.sizeClass?.size, 60, "重量が軽ければ寸法どおりの区分");

  const tooHeavy = resolveSagawaSizeFromCm({ widthCm: 15, depthCm: 15, heightCm: 10, weightKg: 51 });
  assertEqual(tooHeavy.sizeClass, null, "§26 50kg超は判定不可");
  assertEqual(tooHeavy.unavailableReason, "OVER_MAX_WEIGHT", "50kg超の理由を返す");
}

function testSagawaUnavailable() {
  const missing = resolveSagawaSizeFromCm({ widthCm: 60, depthCm: null, heightCm: 30 });
  assertEqual(missing.sizeClass, null, "§10 寸法が欠けていれば判定しない");
  assertEqual(missing.unavailableReason, "DIMENSIONS_MISSING", "欠けている理由を返す");

  const over = resolveSagawaSizeFromCm({ widthCm: 100, depthCm: 100, heightCm: 45 }); // 245 + 20 = 265
  assertEqual(over.sizeClass, null, "260cm超は判定不可");
  assertEqual(over.unavailableReason, "OVER_MAX_SIZE", "上限超の理由を返す");
}

/** 座面寸法を辺として拾わない(rank.ts と同じ保証を佐川側でも通す)。 */
function testSagawaUsesOuterDimensionsOnly() {
  const r = resolveSagawaSize({ width: "座面幅41 46", depth: "53.5", height: "座面高さ46.5 79" });
  // 外形は 46 / 53.5 / 79 = 178.5 → +20 = 198.5 → 200サイズ。
  assertEqual(r.productSumCm, 178.5, "座面寸法を外形3辺として拾わない");
  assertEqual(r.sizeClass?.size, 200, "外形だけで区分を決める");
}

/* ══════════════════════════════════════════════════════════════════
 * §6-1 座面寸法
 * ══════════════════════════════════════════════════════════════════ */

function testSeatDimensions() {
  // 実データそのままの書き方(Staging実測 872件)。
  const a = parseSeatDimensionsText("幅41 奥行40 高さ47");
  assertEqual([a.width, a.depth, a.height], ["41", "40", "47"], "座面: 標準的な書き方を読める");
  assertTrue(a.hasAll, "座面: 3軸そろっている");

  const b = parseSeatDimensionsText("幅59奥行60高さ43");
  assertEqual([b.width, b.depth, b.height], ["59", "60", "43"], "座面: 区切りが無くても読める");

  const c = parseSeatDimensionsText("座面幅42座面奥行42座面高さ46");
  assertEqual([c.width, c.depth, c.height], ["42", "42", "46"], "座面: 各軸に「座面」が付いていても読める");

  const d = parseSeatDimensionsText("奥行40 幅45");
  assertEqual([d.width, d.depth, d.height], ["45", "40", null], "座面: 順序が違っても読め、無い軸はnull");
  assertTrue(!d.hasAll, "座面: 高さが無ければ hasAll は false");

  const e = parseSeatDimensionsText("幅46 奥行42 高さ43-53");
  assertEqual(e.height, "43-53", "座面: 範囲表記(昇降式)を数値へ丸めない");

  const f = parseSeatDimensionsText("高さ38");
  assertEqual([f.width, f.depth, f.height], [null, null, "38"], "座面: 1軸だけでも読む");

  const g = parseSeatDimensionsText("幅41 奥行40.5 高さ46.5");
  assertEqual([g.width, g.depth, g.height], ["41", "40.5", "46.5"], "座面: 小数点を保つ");

  assertEqual(parseSeatDimensionsText(null).hasAny, false, "座面: 未登録なら何も返さない");
  assertEqual(parseSeatDimensionsText("41 40 47").hasAny, false, "座面: ラベルが無い数値の羅列は推測で割り当てない");
}

function testSeatDimensionsFromAxes() {
  // rank.ts が送料判定から除外した候補を拾う。
  const r = resolveSeatDimensions({
    seatDimensionsField: null,
    width: "座面幅41 46",
    depth: "53.5",
    height: "座面高さ46.5 79",
  });
  assertEqual(r.source, "AXIS_LABELS", "座面: CustomFieldが無ければ寸法欄の座面表記から拾う");
  assertEqual([r.width, r.height], ["41", "46.5"], "座面: 寸法欄から幅・高さを拾える");

  const preferField = resolveSeatDimensions({
    seatDimensionsField: "幅41 奥行40 高さ47",
    width: "座面幅99 46",
    depth: null,
    height: null,
  });
  assertEqual(preferField.source, "SEAT_DIMENSIONS_FIELD", "座面: CustomFieldがあればそちらを優先する");
  assertEqual(preferField.width, "41", "座面: CustomFieldの値が使われる");
}

function testSeatDimensionsLine() {
  assertEqual(
    formatSeatDimensionsLine(parseSeatDimensionsText("幅46 奥行41 高さ46.5")),
    "座面寸法:幅46×奥行41×高さ46.5cm",
    "§6-1 座面寸法の行(§27の実例と同じ形)",
  );
  assertEqual(
    formatSeatDimensionsLine(parseSeatDimensionsText("高さ38")),
    "座面寸法:高さ38cm",
    "§21 取れた軸だけを書く（欠けた軸を埋めない）",
  );
  assertEqual(formatSeatDimensionsLine(parseSeatDimensionsText(null)), null, "§21 座面寸法が無ければ行ごと出さない");
}

/* ══════════════════════════════════════════════════════════════════
 * §11-§13 メンテナンスの判定
 * ══════════════════════════════════════════════════════════════════ */

function testMaintenanceDetection() {
  // 実データそのまま: damageNotes に一語だけ入る形。
  const rinser = detectMaintenance({ damageNotes: "リンサー" });
  assertEqual([rinser.rinser, rinser.polish, rinser.coating], [true, false, false], "リンサーのみを検出する");

  const polish = detectMaintenance({ note: "天板は研磨をして、オイル塗装を施しております。" });
  assertEqual([polish.polish, polish.coating], [true, false], "研磨のみ(コーティングの記録は無い)");

  const both = detectMaintenance({ note: "研磨後にコーティングを施工" });
  assertEqual([both.polish, both.coating], [true, true], "研磨+コーティングを両方検出する");

  const cleaning = detectMaintenance({ listingNotes: "クリーニング済み" });
  assertEqual([cleaning.cleaning, cleaning.rinser], [true, false], "クリーニングのみ");

  const none = detectMaintenance({ damageNotes: "小傷あり", note: "販売価格25,000別" });
  assertEqual(none.hasAny, false, "メンテナンスの記録が無ければ何も検出しない");

  // §13 記録が無いものを「有る」にしない。実データ: note = "研磨、塗装無し"。
  const negated = detectMaintenance({ note: "研磨、塗装無し" });
  assertEqual(negated.polish, false, "§13 「研磨、塗装無し」を研磨済みと読まない");
  const negated2 = detectMaintenance({ note: "コーティングなし" });
  assertEqual(negated2.coating, false, "§13 「コーティングなし」をコーティング済みと読まない");
  const planned = detectMaintenance({ note: "研磨予定" });
  assertEqual(planned.polish, false, "予定を実施記録として読まない");

  // 「プロ仕上げ」は何をしたか決まらないので採らない(商品名に118件)。
  const proFinish = detectMaintenance({ name: "Magis Troy Chair / プロ仕上げ モダン" });
  assertEqual(proFinish.hasAny, false, "§13 「プロ仕上げ」だけでは研磨と断定しない");

  // 根拠を残す(画面で人が確かめられるように)。
  assertTrue(rinser.evidence.length > 0 && rinser.evidence[0].field === "傷汚れ箇所等メモ", "判定の根拠(項目名)を残す");
}

/**
 * 実データで踏んだ不具合の固定。
 *
 * `damageNotes = "リンサー"`(実測71件)は**メンテナンスの記録**であって
 * 顧客向けの状態説明ではない。そのまま使うと、生成された商品説明の
 * ◎コンディションに「リンサー」という社内語が単独で現れる(実際に
 * B004790 の生成結果で確認した)。さらに「傷の記録がある」と誤判定され、
 * 傷が無い商品で「良好なコンディションです」を出せなくなる。
 */
function testStripMaintenanceOnlyLines() {
  assertEqual(stripMaintenanceOnlyLines("リンサー"), null, "メンテナンスの記録だけの行は状態説明として残さない");
  assertEqual(stripMaintenanceOnlyLines("リンサー済み"), null, "「済み」が付いていても同じ");
  assertEqual(
    stripMaintenanceOnlyLines("リンサー\n一部小傷・使用感あり"),
    "一部小傷・使用感あり",
    "傷の記述がある行は残す",
  );
  assertEqual(stripMaintenanceOnlyLines("小傷あり"), "小傷あり", "傷の記述はそのまま残す");
  assertEqual(stripMaintenanceOnlyLines("天板に凹み、傷有り"), "天板に凹み、傷有り", "複合的な記述を壊さない");
  assertEqual(stripMaintenanceOnlyLines(null), null, "未登録はnull");
  assertEqual(stripMaintenanceOnlyLines("研磨、コーティング"), null, "複数のメンテナンス語だけの行も落とす");
}

function testMaintenanceOnlyDamageNotesEndToEnd() {
  // B004790 と同じ形: damageNotes="リンサー" / conditionRating="4"。
  const facts = buildListingFacts({ ...CHAIR_INPUT, damageNotes: "リンサー", listingNotes: null });
  assertEqual(facts.maintenance.rinser, true, "リンサーの記録は判定に使う(落とす前に判定する)");
  assertEqual(facts.safe.conditionDisclosure, null, "「リンサー」を顧客向けの状態説明にしない");

  const section = buildConditionSection({
    maintenance: facts.maintenance,
    nonFabric: facts.nonFabric,
    conditionDisclosure: facts.safe.conditionDisclosure,
    goodConditionEvidence: facts.goodConditionEvidence,
  });
  assertTrue(!/^リンサー$/m.test(section.text), "◎コンディションに「リンサー」が単独で現れない");
  assertTrue(section.text.includes(RINSER_SENTENCE), "リンサーはファブリック洗浄の文章として出る");
  assertTrue(section.text.includes(GOOD_CONDITION_SENTENCE), "傷の記録が無いので良好の文章を出せる");

  // 傷の記述が併記されている場合は、そちらを残して良好とは書かない。
  const withDamage = buildListingFacts({
    ...CHAIR_INPUT,
    damageNotes: "リンサー\n一部小傷・使用感あり",
    listingNotes: null,
  });
  assertEqual(withDamage.safe.conditionDisclosure, "一部小傷・使用感あり", "傷の記述だけを状態説明として残す");
  const withDamageSection = buildConditionSection({
    maintenance: withDamage.maintenance,
    nonFabric: withDamage.nonFabric,
    conditionDisclosure: withDamage.safe.conditionDisclosure,
    goodConditionEvidence: withDamage.goodConditionEvidence,
  });
  assertTrue(!withDamageSection.text.includes(GOOD_CONDITION_SENTENCE), "傷の記述があれば良好と書かない");
  assertTrue(withDamageSection.text.includes("一部小傷・使用感あり"), "傷の記述は必ず出す");
}

function testNonFabric() {
  assertEqual(looksNonFabric({ material: "ガラス" }), true, "§12 材質がガラスならファブリックは無いと判断する");
  assertEqual(looksNonFabric({ material: "ファブリック" }), false, "材質がファブリックなら当然ある");
  assertEqual(looksNonFabric({ material: null }), false, "§12 材質が不明なら「無い」と決めつけない");
  assertEqual(looksNonFabric({ material: "木材とファブリック" }), false, "布を含むなら false");
  // フレーム材になりうるものは「布が無い」の根拠にしない —— 木やスチールの
  // 椅子に布張りの座面が付くのはこの在庫では普通(実データ)。
  assertEqual(looksNonFabric({ material: "木材" }), false, "§12 木材は布張りの座面と同居しうるので除外しない");
  assertEqual(looksNonFabric({ material: "スチール" }), false, "§12 スチールも同様");
  assertEqual(looksNonFabric({ material: "大理石" }), true, "§12 大理石は布張り部分と同居しない");
}

/* ══════════════════════════════════════════════════════════════════
 * §11-§16 ◎コンディション
 * ══════════════════════════════════════════════════════════════════ */

function conditionOf(input: {
  maintenance: ReturnType<typeof detectMaintenance>;
  nonFabric?: boolean;
  conditionDisclosure?: string | null;
  goodConditionEvidence?: boolean;
}) {
  return buildConditionSection({
    maintenance: input.maintenance,
    nonFabric: input.nonFabric ?? false,
    conditionDisclosure: input.conditionDisclosure ?? null,
    goodConditionEvidence: input.goodConditionEvidence ?? false,
  });
}

function testConditionSection() {
  // §26 リンサーのみ
  const rinser = conditionOf({ maintenance: detectMaintenance({ damageNotes: "リンサー" }) });
  assertTrue(rinser.text.includes(RINSER_SENTENCE), "リンサーのみ: 薬剤師監修の文章が入る");
  assertTrue(!rinser.text.includes(POLISH_SENTENCE), "リンサーのみ: 研磨の文章は入らない");

  // §26 研磨のみ
  const polish = conditionOf({ maintenance: detectMaintenance({ note: "天板を研磨しました" }) });
  assertTrue(polish.text.includes(POLISH_SENTENCE), "研磨のみ: 研磨の文章が入る");
  assertTrue(!polish.text.includes("コーティング"), "§13 コーティング記録が無ければコーティング済みと書かない");

  // §26 研磨 + コーティング
  const both = conditionOf({ maintenance: detectMaintenance({ note: "研磨のうえコーティング施工" }) });
  assertTrue(both.text.includes(POLISH_COATING_SENTENCE), "研磨+コーティング: 1文にまとめた文章が入る");
  assertTrue(!both.text.includes(POLISH_SENTENCE), "研磨+コーティング: 研磨だけの文章は入らない");

  // コーティングのみ(研磨の記録が無い)
  const coatingOnly = conditionOf({ maintenance: detectMaintenance({ note: "コーティング施工済み" }) });
  assertTrue(coatingOnly.text.includes(COATING_ONLY_SENTENCE), "コーティングのみ: 研磨に触れない文章を使う");
  assertTrue(!coatingOnly.text.includes("研磨"), "コーティングのみ: 研磨したと書かない");

  // §26 クリーニングのみ
  const cleaning = conditionOf({ maintenance: detectMaintenance({ listingNotes: "クリーニング済み" }) });
  assertTrue(cleaning.text.includes(CLEANING_SENTENCE), "クリーニングのみ: クリーニングの文章が入る");
  assertTrue(!cleaning.text.includes(RINSER_SENTENCE), "クリーニングのみ: ファブリック洗浄の文章とは分ける");

  // §26 複数メンテナンス(リンサー + 研磨 + コーティング)
  const multi = conditionOf({ maintenance: detectMaintenance({ damageNotes: "リンサー", note: "研磨・コーティング" }) });
  assertTrue(multi.text.includes(POLISH_COATING_SENTENCE), "複数: 研磨+コーティングの文章が入る");
  assertTrue(multi.text.includes(RINSER_SENTENCE), "複数: リンサーの文章も入る");

  // §12 ファブリックが無い商品にリンサーの文章を使わない
  const nonFabric = conditionOf({ maintenance: detectMaintenance({ damageNotes: "リンサー" }), nonFabric: true });
  assertTrue(!nonFabric.text.includes(RINSER_SENTENCE), "§12 材質と矛盾する場合はファブリック洗浄の文章を使わない");
  assertTrue(
    nonFabric.warnings.some((w) => w.includes("ファブリック")),
    "§12 使わなかったことを黙って落とさず警告に残す",
  );

  // §26 メンテナンス記録なし
  const noMaintenance = conditionOf({ maintenance: detectMaintenance({}) });
  assertTrue(
    noMaintenance.warnings.some((w) => w.includes("メンテナンスの記録")),
    "§26 メンテナンス記録が無いことを警告する",
  );
}

function testConditionState() {
  // §26 良好
  const good = conditionOf({ maintenance: detectMaintenance({}), goodConditionEvidence: true });
  assertTrue(good.text.includes(GOOD_CONDITION_SENTENCE), "§14 良好の根拠があれば良好の文章を使う");

  // §14 傷の記録があるのに「良好」と書かない —— ここが最重要。
  const damaged = conditionOf({
    maintenance: detectMaintenance({}),
    conditionDisclosure: "アームや脚部に一部使用感や小傷が見られます",
    goodConditionEvidence: true,
  });
  assertTrue(!damaged.text.includes(GOOD_CONDITION_SENTENCE), "§14 傷の記録があるとき「目立つ傷なし」と書かない");
  assertTrue(damaged.text.includes("小傷が見られます"), "§14 登録されている傷の記述をそのまま出す");

  // §26 汚れあり / 補修跡あり
  for (const [text, label] of [
    ["座面に汚れがあります", "汚れあり"],
    ["脚部に補修跡があります", "補修跡あり"],
  ] as const) {
    const r = conditionOf({ maintenance: detectMaintenance({}), conditionDisclosure: text });
    assertTrue(r.text.includes(text), `§26 ${label}: 記載をそのまま出す`);
    assertTrue(!r.text.includes(GOOD_CONDITION_SENTENCE), `§26 ${label}: 良好と書かない`);
  }

  // §26 コンディション情報不足
  const unknown = conditionOf({ maintenance: detectMaintenance({}) });
  assertTrue(!unknown.text.includes(GOOD_CONDITION_SENTENCE), "§21 根拠が無いのに良好と書かない");
  assertTrue(
    unknown.warnings.some((w) => w.includes("コンディションの情報")),
    "§21 状態の情報が無いことを警告する",
  );

  // §15/§16 共通文はどの分岐でも必ず入る。
  for (const r of [good, damaged, unknown]) {
    assertTrue(r.text.includes(CONDITION_CLOSING), "§15 コンディション共通文が必ず入る");
    assertTrue(r.text.includes(COMMON_NOTICES), "§16 共通注意事項が必ず入る");
  }
}

function testGoodConditionEvidence() {
  assertEqual(hasGoodConditionEvidence("4"), true, "社内評価4.0以上は良好の根拠");
  assertEqual(hasGoodConditionEvidence("4.5"), true, "4.5も良好");
  assertEqual(hasGoodConditionEvidence("3.5"), false, "3.5は良好とみなさない");
  assertEqual(hasGoodConditionEvidence("3"), false, "3は良好とみなさない");
  assertEqual(hasGoodConditionEvidence(null), false, "未登録は根拠にならない");
  assertEqual(hasGoodConditionEvidence("目立つ傷なし"), true, "文章で「目立つ傷なし」と書かれていれば根拠になる");
  assertEqual(hasGoodConditionEvidence("良好"), true, "文章で「良好」と書かれていれば根拠になる");
  assertEqual(hasGoodConditionEvidence("補修跡あり"), false, "補修跡ありを良好と読まない");
  assertEqual(hasGoodConditionEvidence("傷あり"), false, "傷ありを良好と読まない");
}

/* ══════════════════════════════════════════════════════════════════
 * §6/§7/§10 ◎商品詳細 / ◎発送について
 * ══════════════════════════════════════════════════════════════════ */

function testProductDetailSection() {
  const text = buildProductDetailSection({
    width: "46",
    depth: "53.5",
    height: "79",
    overallLength: null,
    seat: parseSeatDimensionsText("幅46 奥行41 高さ46.5"),
  });
  assertEqual(
    text,
    "幅:46cm\n奥行:53.5cm\n高さ:79cm\n座面寸法:幅46×奥行41×高さ46.5cm",
    "§27 商品詳細が実例どおりの形になる",
  );

  const noSeat = buildProductDetailSection({
    width: "120",
    depth: "45",
    height: "72",
    overallLength: null,
    seat: parseSeatDimensionsText(null),
  });
  assertEqual(noSeat, "幅:120cm\n奥行:45cm\n高さ:72cm", "§21 座面寸法が無ければ行ごと出さない(推測しない)");

  const partial = buildProductDetailSection({
    width: "120",
    depth: null,
    height: "72",
    overallLength: null,
    seat: parseSeatDimensionsText(null),
  });
  assertEqual(partial, "幅:120cm\n高さ:72cm", "§26 サイズ情報不足: 無い軸は書かない");

  const alreadyCm = buildProductDetailSection({
    width: "46cm",
    depth: null,
    height: null,
    overallLength: null,
    seat: parseSeatDimensionsText(null),
  });
  assertEqual(alreadyCm, "幅:46cm", "単位が既に付いていれば二重に付けない");
}

function testShippingSection() {
  const c = buildShippingSection({ rank: "C" });
  assertTrue(c.includes("埼玉県より、家財おまかせ便Cランク、または、自社での配送を予定しております。"), "§7 発送の本文");
  assertTrue(c.includes("＜九州・沖縄・北海道・離島への発送をご希望の方へ＞"), "§7 遠方地域の案内が入る");

  // §10 判定できないときに配送方法を作らない。
  const unknown = buildShippingSection({ rank: null, unresolvedReason: "寸法を読み取れません" });
  assertTrue(unknown.includes(SHIPPING_UNDETERMINED_MARKER), "§10 判定不能なら未確定の印を残す");
  assertTrue(!unknown.includes("ランク"), "§10 判定不能なのにランクを書かない");
  assertTrue(unknown.includes("＜九州・沖縄・北海道・離島"), "§10 判定不能でも遠方地域の案内は出す");

  // 規格外はランク表の外なので、ランク名を書かない。
  const oversize = buildShippingSection({ rank: "OVERSIZE" });
  assertTrue(oversize.includes(SHIPPING_UNDETERMINED_MARKER), "規格外候補はランク名を書かず未確定として扱う");
}

/* ══════════════════════════════════════════════════════════════════
 * §20/§21 Product Context
 * ══════════════════════════════════════════════════════════════════ */

const CHAIR_INPUT = {
  name: "ASPLUND RESORTIR / HARM SIDE CHAIR / ナチュラル モダン ダイニングチェア",
  categoryName: "ダイニングチェア",
  brand: "ASPLUND",
  width: "46",
  depth: "53.5",
  height: "79",
  overallLength: null,
  seatDimensionsField: "幅46 奥行41 高さ46.5",
  material: "木材",
  conditionRating: "4",
  damageNotes: null,
  note: null,
  listingNotes: "研磨とコーティングを実施",
  adminMemo: null,
};

function testListingFacts() {
  const facts = buildListingFacts(CHAIR_INPUT);
  assertEqual(facts.shippingRank, "B", "§8 家財おまかせ便のランクは既存ロジックで判定する(3辺合計178.5cm → Bランク: 〜200cm)");
  assertEqual(facts.shippingSumCm, 178.5, "3辺合計を持つ");
  assertEqual(facts.sagawa.sizeClass?.size, 200, "佐川サイズも同時に確定する(178.5+20=198.5 → 200)");
  assertEqual(facts.seat.hasAll, true, "座面寸法を3軸そろえて読める");
  assertEqual([facts.maintenance.polish, facts.maintenance.coating], [true, true], "メンテナンスを判定する");
  assertEqual(facts.goodConditionEvidence, true, "社内評価4は良好の根拠");
  assertEqual(facts.material, "木材", "材質を持つ");
  // 社内スコアは顧客向けの事実へ入れない(既存の facts.ts の保証)。
  assertTrue(!JSON.stringify(facts.safe).includes('"4"'), "社内のコンディション評価は顧客向け事実へ入れない");

  // §21 足りないものを埋めず、警告に積む。
  const sparse = buildListingFacts({
    ...CHAIR_INPUT,
    width: null,
    depth: null,
    height: null,
    seatDimensionsField: null,
    material: null,
    conditionRating: null,
    listingNotes: null,
  });
  assertEqual(sparse.shippingRank, null, "§10 寸法が無ければ配送ランクを確定しない");
  assertEqual(sparse.seat.hasAny, false, "§21 座面寸法を推測しない");
  assertEqual(sparse.material, null, "§21 材質を推測しない");
  assertTrue(
    sparse.warnings.some((w) => w.includes("座面寸法が登録されていません")),
    "§21 「⚠ 座面寸法が登録されていません」を出す",
  );
  assertTrue(
    sparse.warnings.some((w) => w.includes("配送ランクを確定できません")),
    "§21 「⚠ 配送ランクを確定できません」を出す",
  );

  // ZAICOの「-」「不明」を材質として採らない。
  assertEqual(buildListingFacts({ ...CHAIR_INPUT, material: "不明" }).material, null, "材質の「不明」を値として扱わない");
}

/* ══════════════════════════════════════════════════════════════════
 * §4/§27 商品説明全体
 * ══════════════════════════════════════════════════════════════════ */

function testComposeListingDescription() {
  const facts = buildListingFacts(CHAIR_INPUT);
  const condition = buildConditionSection({
    maintenance: facts.maintenance,
    nonFabric: facts.nonFabric,
    conditionDisclosure: facts.safe.conditionDisclosure,
    goodConditionEvidence: facts.goodConditionEvidence,
  });
  const full = composeListingDescription({
    introduction: "ASPLUND（アスプルンド）のダイニングチェアです。",
    productDetail: buildProductDetailSection({
      width: facts.width,
      depth: facts.depth,
      height: facts.height,
      overallLength: facts.overallLength,
      seat: facts.seat,
    }),
    shipping: buildShippingSection({ rank: facts.shippingRank }),
    condition: condition.text,
  });

  // §4 セクションの並び。
  const order = ["◎商品のご紹介", "◎商品詳細", "◎発送について", "◎コンディション", "◎返品・返金対応について", "◎お取り置きについて"];
  let cursor = -1;
  for (const heading of order) {
    const at = full.indexOf(heading);
    assertTrue(at > cursor, `§4 ${heading} が正しい位置にある`);
    cursor = at;
  }

  // §17/§18 固定テンプレートは必ず入る。
  assertTrue(full.includes(RETURN_POLICY_BODY), "§17 返品・返金対応の本文が丸ごと入る");
  assertTrue(full.includes(HOLD_POLICY_BODY), "§18 お取り置きの本文が丸ごと入る");
  assertTrue(full.includes(COMMON_NOTICES), "§16 共通注意事項が入る");

  // §27 実例の要点。
  assertTrue(full.includes("座面寸法:幅46×奥行41×高さ46.5cm"), "§27 座面寸法の行");
  assertTrue(full.includes(POLISH_COATING_SENTENCE), "§27 研磨+コーティングの文章");
  assertTrue(full.includes(GOOD_CONDITION_SENTENCE), "§27 良好のコンディション文");

  // §19 寸法は◎商品詳細にだけ現れる(紹介文へ混ぜない)。
  const introBlock = full.slice(full.indexOf("◎商品のご紹介"), full.indexOf("◎商品詳細"));
  assertTrue(!/\d+cm/.test(introBlock), "§5/§19 紹介文に寸法を書かない");

  // 紹介文が無くても(生成失敗)、確定した部分は出せる。
  const noIntro = composeListingDescription({
    introduction: null,
    productDetail: "幅:46cm",
    shipping: buildShippingSection({ rank: "C" }),
    condition: condition.text,
  });
  assertTrue(!noIntro.includes("◎商品のご紹介"), "紹介文が無ければ見出しごと出さない");
  assertTrue(noIntro.includes("◎返品・返金対応について"), "紹介文が無くても固定テンプレートは出る");
}

/* ══════════════════════════════════════════════════════════════════
 * §25 チャネル別formatter
 * ══════════════════════════════════════════════════════════════════ */

function testChannelFormatter() {
  assertEqual(normalizeDescription("a\r\nb\r\n\r\n\r\nc"), "a\nb\n\nc", "改行をLFへ寄せ、3行以上の空行は畳む");
  assertEqual(normalizeDescription("  a  \n  "), "a", "末尾の空白を落とす");

  const r = formatDescriptionForChannel("◎商品のご紹介\r\n本文", "BASE");
  assertEqual(r.text, "◎商品のご紹介\n本文", "BASEへ送る前に改行を正規化する");
  assertEqual(r.truncated, false, "§25 上限が未確認のチャネルでは切り詰めない");

  const html = formatDescriptionForChannel("<b>強調</b>", "MERCARI_SHOPS");
  assertTrue(html.notes.some((n) => n.includes("HTML")), "HTMLタグらしき記述があれば知らせる");
  assertEqual(html.text, "<b>強調</b>", "§25 勝手にタグを消して本文を壊さない");

  // 共通文章そのものを変えない(呼び出し前後で同じ文字列であること)。
  const source = "◎商品のご紹介\n本文";
  formatDescriptionForChannel(source, "BASE");
  assertEqual(source, "◎商品のご紹介\n本文", "§25 共通の商品説明を書き換えない");
}

function main() {
  console.log("── §9/§26 佐川急便のサイズ判定 ─────────────────────");
  testSagawaBoundaries();
  testSagawaPackingAllowance();
  testSagawaLargeService();
  testSagawaWeight();
  testSagawaUnavailable();
  testSagawaUsesOuterDimensionsOnly();

  console.log("\n── §6-1 座面寸法 ───────────────────────────────────");
  testSeatDimensions();
  testSeatDimensionsFromAxes();
  testSeatDimensionsLine();

  console.log("\n── §11-§13 メンテナンスの判定 ──────────────────────");
  testMaintenanceDetection();
  testStripMaintenanceOnlyLines();
  testMaintenanceOnlyDamageNotesEndToEnd();
  testNonFabric();

  console.log("\n── §11-§16 ◎コンディション ────────────────────────");
  testConditionSection();
  testConditionState();
  testGoodConditionEvidence();

  console.log("\n── §6/§7/§10 ◎商品詳細 / ◎発送について ────────────");
  testProductDetailSection();
  testShippingSection();

  console.log("\n── §20/§21 Product Context ─────────────────────────");
  testListingFacts();

  console.log("\n── §4/§27 商品説明全体 ─────────────────────────────");
  testComposeListingDescription();

  console.log("\n── §25 チャネル別formatter ─────────────────────────");
  testChannelFormatter();

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
