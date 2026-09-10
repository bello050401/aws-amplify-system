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
  requiresSeatDimensions,
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
import {
  buildListingFacts,
  buildShippingWarning,
  hasGoodConditionEvidence,
  KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX,
  SAGAWA_UNAVAILABLE_WARNING_PREFIX,
  withCurrentShippingWarning,
} from "@/lib/ai/productPage/listingFacts";
import { formatDescriptionForChannel, normalizeDescription } from "@/lib/listing/descriptionFormat";
import {
  DEFAULT_LISTING_SHIPPING_METHOD,
  LISTING_SHIPPING_METHODS,
  parseListingShippingMethod,
} from "@/lib/listing/types";
import {
  isDamageFragment,
  normalizeConditionDisclosure,
  PHOTO_REFERENCE_SENTENCE,
} from "@/lib/inventory/conditionPhrasing";

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
  assertEqual(formatSagawaSize(r), "佐川急便160サイズ", "§1 表記は「佐川急便160サイズ」(追加指示の例文どおり)");

  // 商品の3辺合計をそのまま使っていないこと。使っていれば140サイズになる。
  assertTrue(r.sizeClass?.size !== 140, "§9 商品の3辺合計をそのまま区分に使わない");
}

function testSagawaLargeService() {
  const r = resolveSagawaSizeFromCm({ widthCm: 70, depthCm: 60, heightCm: 40 }); // 170 + 20 = 190 → 200
  assertEqual(r.sizeClass?.size, 200, "飛脚ラージ: 判定値190 → 200サイズ");
  assertEqual(
    formatSagawaSize(r),
    "佐川急便（飛脚ラージサイズ宅配便）200サイズ",
    "170以上は別サービスなので、その名前が分かる表記にする",
  );
}

/**
 * 追加指示 §2: 重量は一切見ない。
 *
 * BELLOには重量の項目が無く、運用もサイズ基準。**重量の有無で判定が
 * 変わらない**ことを型と実測の両方で固定する(型に weightKg が残っていると
 * いつか誰かが渡し、渡されないことを前提にした説明文と食い違う)。
 */
function testSagawaIgnoresWeight() {
  const r = resolveSagawaSizeFromCm({ widthCm: 15, depthCm: 15, heightCm: 10 });
  assertEqual(r.sizeClass?.size, 60, "§2 小さい荷物は重量に関わらず60サイズ(40+20=60)");
  assertTrue(!/重量|kg/.test(r.note), "§2 説明に重量へ触れる文言を出さない");
  assertTrue(
    !Object.keys(r).includes("weightKg"),
    "§2 判定結果に重量の項目を持たない(重量を見ていないことを型で示す)",
  );
  // 追加指示前は 3辺合計40cm + 重量8kg で100サイズになっていた。
  // いまは寸法だけで決まるので、同じ寸法なら常に同じ区分。
  const again = resolveSagawaSizeFromCm({ widthCm: 15, depthCm: 15, heightCm: 10 });
  assertEqual(again.sizeClass?.size, r.sizeClass?.size, "§2 同じ寸法なら常に同じ区分");
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
  // §5 断片は文章へ整えられる(事実は変えない)。
  assertTrue(
    withDamageSection.text.includes("一部に小傷や使用感がございます。"),
    "傷の記述は文章へ整えたうえで必ず出す",
  );
  assertTrue(withDamageSection.text.includes("詳細はお写真をご確認ください。"), "§5 傷がある商品には写真の案内を添える");
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
  assertTrue(
    c.includes("埼玉県より、らくらく家財便Cランク、または、自社での配送を予定しております。"),
    "§1/§7 らくらく家財便を選んだときの発送の本文",
  );
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
 * 追加指示 §1 配送方法の選択
 * ══════════════════════════════════════════════════════════════════ */

function testShippingMethodSwitching() {
  // 既定は らくらく家財便。
  assertEqual(DEFAULT_LISTING_SHIPPING_METHOD, "KAZAI", "§1 既定の配送方法はらくらく家財便");
  assertEqual(
    LISTING_SHIPPING_METHODS.map((m) => `${m.code}:${m.label}`),
    ["KAZAI:らくらく家財便", "SAGAWA:佐川急便"],
    "§1 選択肢は2つ、既定が先頭",
  );
  assertEqual(parseListingShippingMethod(null), "KAZAI", "§1 未設定はらくらく家財便として読む(既存下書きの互換)");
  assertEqual(parseListingShippingMethod("SAGAWA"), "SAGAWA", "§1 保存済みの佐川を読み戻せる");
  assertEqual(parseListingShippingMethod("なにか他の値"), "KAZAI", "§1 未知の値は既定へ倒す");

  // 同じ商品(3辺合計177cm → 家財B / 佐川197cm → 200サイズ)で、
  // 選択によって「◎発送について」だけが切り替わること。
  const facts = buildListingFacts({ ...CHAIR_INPUT, width: "47", depth: "50", height: "80" });
  const kazai = buildShippingSection({
    method: "KAZAI",
    rank: facts.shippingRank,
    sagawaSizeLabel: formatSagawaSize(facts.sagawa),
  });
  const sagawa = buildShippingSection({
    method: "SAGAWA",
    rank: facts.shippingRank,
    sagawaSizeLabel: formatSagawaSize(facts.sagawa),
  });

  assertTrue(kazai.includes("らくらく家財便Bランク"), "§1 らくらく家財便を選ぶと既存のランク判定が入る");
  assertTrue(!kazai.includes("佐川"), "§1 らくらく家財便のときに佐川のサイズを書かない");
  assertTrue(sagawa.includes("佐川急便（飛脚ラージサイズ宅配便）200サイズ"), "§1 佐川急便を選ぶと3辺合計+20cmの判定が入る");
  assertTrue(!sagawa.includes("らくらく家財便"), "§1 佐川のときに家財便のランクを書かない");
  // 遠方地域の案内はどちらでも出す。
  for (const text of [kazai, sagawa]) {
    assertTrue(text.includes("＜九州・沖縄・北海道・離島への発送をご希望の方へ＞"), "§1 遠方地域の案内はどちらの方法でも出す");
  }

  // 未指定は既定(らくらく家財便)として扱う。
  const omitted = buildShippingSection({ rank: facts.shippingRank, sagawaSizeLabel: formatSagawaSize(facts.sagawa) });
  assertEqual(omitted, kazai, "§1 配送方法を渡さなければ既定のらくらく家財便として組み立てる");

  // §10 サイズ不足で確定できないときは、どちらを選んでも推測しない。
  const noDims = buildListingFacts({ ...CHAIR_INPUT, width: null, depth: null, height: null });
  const kazaiUnknown = buildShippingSection({ method: "KAZAI", rank: noDims.shippingRank, sagawaSizeLabel: formatSagawaSize(noDims.sagawa) });
  const sagawaUnknown = buildShippingSection({ method: "SAGAWA", rank: noDims.shippingRank, sagawaSizeLabel: formatSagawaSize(noDims.sagawa) });
  assertTrue(kazaiUnknown.includes(SHIPPING_UNDETERMINED_MARKER), "§10 寸法不足なら家財便でも未確定の印");
  assertTrue(sagawaUnknown.includes(SHIPPING_UNDETERMINED_MARKER), "§10 寸法不足なら佐川でも未確定の印");
  assertTrue(!/ランク|サイズ/.test(sagawaUnknown.split("\n")[0]), "§10 誤ったサイズ・ランクを書かない");
}

/* ══════════════════════════════════════════════════════════════════
 * 追加指示 §5 コンディション表現の正規化
 * ══════════════════════════════════════════════════════════════════ */

function testConditionPhrasing() {
  // 指示書§5に挙げられた4つの例をそのまま。
  const cases: [string, string][] = [
    ["小傷あり", "使用に伴う小傷がございます。詳細はお写真をご確認ください。"],
    ["擦れあり", "使用に伴う擦れがございます。詳細はお写真をご確認ください。"],
    ["汚れあり", "一部に汚れがございます。詳細はお写真をご確認ください。"],
    ["小傷・擦れあり", "使用に伴う小傷や擦れがございます。詳細はお写真をご確認ください。"],
  ];
  for (const [input, expected] of cases) {
    assertEqual(normalizeConditionDisclosure(input)?.text, expected, `§5 「${input}」→「${expected}」`);
  }

  // §5 元情報に無いことを足さない。
  const one = normalizeConditionDisclosure("小傷あり")!.text;
  for (const forbidden of ["脚部", "背もたれ", "目立たない", "使用には問題", "程度"]) {
    assertTrue(!one.includes(forbidden), `§5 「${forbidden}」のような推測を足さない`);
  }

  // 既に文章になっているものは書き換えない(事実を保持する)。
  const sentence = "アームや脚部、フレームに一部使用感や小傷が見られますが、いずれも使用時に大きく目立つものではありません。";
  const kept = normalizeConditionDisclosure(sentence)!;
  assertTrue(kept.text.startsWith(sentence), "§5 既に文章になっているものは書き換えない");
  assertEqual(kept.rewritten, false, "§5 書き換えていないことを記録する");
  assertTrue(kept.text.includes(PHOTO_REFERENCE_SENTENCE), "§5 文章の場合も写真の案内は添える");

  // 写真に触れている文章へ二重に足さない。
  const withPhoto = normalizeConditionDisclosure("傷の状態はお写真をご確認ください。")!;
  assertEqual(
    withPhoto.text.split(PHOTO_REFERENCE_SENTENCE).length - 1,
    0,
    "§5 既に写真へ触れているなら案内を重ねない",
  );

  // 傷が無い記述には写真の案内を足さない。
  const noDamage = normalizeConditionDisclosure("座面は張り替え済みです。")!;
  assertEqual(noDamage.hasDamage, false, "§5 傷の語が無ければ写真の案内は入れない");
  assertTrue(!noDamage.text.includes(PHOTO_REFERENCE_SENTENCE), "§5 傷が無ければ案内を足さない");

  // 断片の判定。
  assertTrue(isDamageFragment("小傷あり"), "断片: 語の羅列だけ");
  assertTrue(isDamageFragment("一部小傷・擦れあり"), "断片: 付随語が付いていても断片");
  assertTrue(!isDamageFragment("天板の右手前に長さ3cmの傷があります"), "断片ではない: 場所や大きさが書かれている");
  assertTrue(!isDamageFragment("背面に傷"), "断片ではない: 場所が書かれている(削ると事実が減る)");

  // 場所が書かれているものは、その事実を保ったまま句点だけ整える
  // (今回の改善で「がございます」文末になったが、場所の文字列は変わらない)。
  const located = normalizeConditionDisclosure("背面に傷")!;
  assertTrue(located.text.startsWith("背面に傷"), "§5 場所の情報を落とさない");
  assertTrue(located.text.includes(PHOTO_REFERENCE_SENTENCE), "§5 傷があるので写真の案内は添える");

  assertEqual(normalizeConditionDisclosure(null), null, "未登録なら何も返さない");
  // メンテナンスだけの記述はここへ来ない(呼び出し前に落ちている)。
  assertEqual(stripMaintenanceOnlyLines("リンサー"), null, "§5 メンテナンス情報のみは傷情報として扱わない");
}

/**
 * 追加指示 §5 の再改善: 「天板小傷、脚にサビ」のような、場所と傷語が
 * 「、」で並ぶだけの断片。
 *
 * これは isDamageFragment(場所があれば断片ではないと判定)には引っかからず、
 * 改善前は「天板小傷、脚にサビ。」のように体言止めの断片へ句点を付けるだけ
 * だった(このテストで固定するのは改善後の挙動)。
 */
function testConditionPhrasingLocatedFragments() {
  // 助詞「に」の有無が混在していても、場所ごとの事実を保ったまま1文にする。
  assertEqual(
    normalizeConditionDisclosure("天板小傷、脚にサビ")?.text,
    "天板に小傷、脚にサビがございます。詳細はお写真をご確認ください。",
    "§5 場所+傷語が「、」で並ぶ断片を自然文にする(助詞が無い側にも「に」を補う)",
  );
  assertEqual(
    normalizeConditionDisclosure("天板に小傷、脚部にサビあり")?.text,
    "天板に小傷、脚部にサビがございます。詳細はお写真をご確認ください。",
    "§5 「あり」等の付随語が付いていても同様に整える",
  );

  // サビは新規に追加した語彙。使用に伴うと断定できないので「使用に伴う」を付けない。
  assertEqual(
    normalizeConditionDisclosure("サビあり")?.text,
    "一部にサビがございます。詳細はお写真をご確認ください。",
    "§5 サビは原因を断定できないため「使用に伴う」を付けない",
  );
  assertEqual(
    normalizeConditionDisclosure("小傷・サビあり")?.text,
    "一部に小傷やサビがございます。詳細はお写真をご確認ください。",
    "§5 使用由来の語(小傷)とサビが混ざれば「使用に伴う」は付けない",
  );

  // §21 重大な欠け/破損を軽微に見せない: 程度・大きさの語が前置きに
  // 混ざっているものは場所と決めつけて書き換えず、そのまま残す。
  assertEqual(
    normalizeConditionDisclosure("座面に大きな欠けあり")?.text,
    "座面に大きな欠けあり。詳細はお写真をご確認ください。",
    "§21 「大きな」を場所扱いで素通りさせず、書き換え自体を諦めて事実を残す",
  );
  assertTrue(
    normalizeConditionDisclosure("座面に大きな欠けあり")!.text.includes("大きな"),
    "§21 重大な欠けを軽微な表現に弱めない",
  );

  // 清掃・研磨等のメンテナンス言及と傷の記述が同じ行に既にある場合、
  // 元々「、」でつながった1文であればそのまま(=既に文を繋げた状態)を保つ。
  assertEqual(
    normalizeConditionDisclosure("研磨済み、天板に小傷あり")?.text,
    "研磨済み、天板に小傷あり。詳細はお写真をご確認ください。",
    "§5 メンテナンス言及と傷の記述が既に1文でつながっていれば、そのまま維持する",
  );

  // 既存の§26実例(寸法・配送・返品固定文)には影響しないことの確認は
  // testShippingSection / testComposeListingDescription 側で別途固定済み。

  // ── canonical経路(buildConditionSection)での確認 ──────────────
  //
  // §5のプロンプト側(lib/ai/productPage/prompt.ts)ではなく、実際に本番で
  // 使われる descriptionSections.ts の buildConditionSection → その内部で
  // normalizeConditionDisclosure が呼ばれる経路をそのまま通す(架空の在庫入力)。
  const fictionalMaintenance = detectMaintenance({});
  const before = "天板小傷、脚にサビ。詳細はお写真をご確認ください。"; // 改善前の生の出力(このテストの直前の assertEqual で確認済み)。
  const canonical = buildConditionSection({
    maintenance: fictionalMaintenance,
    nonFabric: false,
    conditionDisclosure: "天板小傷、脚にサビ",
    goodConditionEvidence: false,
  });
  assertTrue(
    canonical.text.includes("天板に小傷、脚にサビがございます。"),
    "§5 canonical経路(buildConditionSection)でも自然文になる(before: 「" + before.split("。")[0] + "。」)",
  );
  assertTrue(!canonical.text.includes(GOOD_CONDITION_SENTENCE), "§5 傷の記述があるので良好の定型文は使わない");
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
 * 2026-09-10追加指示: 警告の適用条件(座面・配送方法・材質)
 * ══════════════════════════════════════════════════════════════════ */

function testRequiresSeatDimensions() {
  // カテゴリがあればカテゴリだけで決める。
  assertEqual(requiresSeatDimensions({ categoryName: "ダイニングチェア" }), true, "椅子カテゴリは座面必須");
  assertEqual(requiresSeatDimensions({ categoryName: "ソファ" }), true, "ソファカテゴリは座面必須");
  assertEqual(requiresSeatDimensions({ categoryName: "スツール" }), true, "スツールカテゴリは座面必須");
  assertEqual(requiresSeatDimensions({ categoryName: "デスク" }), false, "デスクカテゴリは座面対象外");
  assertEqual(requiresSeatDimensions({ categoryName: "テーブル" }), false, "テーブルカテゴリは座面対象外");
  assertEqual(requiresSeatDimensions({ categoryName: "照明" }), false, "照明カテゴリは座面対象外");

  // 商品名の「チェア」等の語だけを無条件の根拠にしない —— カテゴリが
  // デスクなら、商品名にチェアらしき語が混ざっていても対象外を優先する。
  assertEqual(
    requiresSeatDimensions({ categoryName: "デスク", name: "チェアサイドデスク" }),
    false,
    "カテゴリがデスクなら商品名にチェアの語があっても座面対象外",
  );

  // カテゴリ未設定のときだけ商品名を見る。
  assertEqual(requiresSeatDimensions({ categoryName: null, name: "北欧モダンチェア" }), true, "カテゴリ未設定: 商品名から椅子と判定");
  assertEqual(requiresSeatDimensions({ categoryName: null, name: "ナチュラルデスク" }), false, "カテゴリ未設定: 商品名からデスクと判定");
  // 商品名にデスク/テーブル/照明を示す語があれば、座面を示す語より優先して対象外にする。
  assertEqual(
    requiresSeatDimensions({ categoryName: null, name: "チェアサイドテーブル" }),
    false,
    "カテゴリ未設定: 商品名にテーブルの語があれば対象外を優先する",
  );
  assertEqual(requiresSeatDimensions({ categoryName: null, name: null }), false, "カテゴリ・商品名どちらも無ければ対象外");

  // ── レビュー対応(2026-09-10): BELLO実カテゴリは業務区分 ────────────
  //
  // 実データの categoryName は「販売中」「撮影待ち」「川越移動予定,
  // 五十嵐さん」のような業務区分で、商品種別を示さない。椅子でも
  // categoryName はこの形になりうるので、こうした値は商品種別の根拠に
  // せず商品名へフォールバックする(=カテゴリを無視するのではなく、
  // 「そのカテゴリが商品種別を示していない」ときだけ商品名を見る)。
  assertEqual(
    requiresSeatDimensions({ categoryName: "販売中", name: "北欧モダン チェア" }),
    true,
    "業務区分カテゴリ(販売中)+商品名の椅子: 商品名で座面必須と判定",
  );
  assertEqual(
    requiresSeatDimensions({ categoryName: "撮影待ち", name: "北欧イスセット" }),
    true,
    "業務区分カテゴリ(撮影待ち)+商品名のイス(実表記): 座面必須",
  );
  assertEqual(
    requiresSeatDimensions({ categoryName: "川越移動予定,五十嵐さん", name: "北欧モダン デスク 関連:チェア" }),
    false,
    "業務区分カテゴリ+デスク(「関連:チェア」は検索参考語なので無視): 座面対象外",
  );
  // カテゴリが実表記の商品種別を示していれば、従来どおりカテゴリだけで決める。
  assertEqual(requiresSeatDimensions({ categoryName: "椅子" }), true, "椅子カテゴリ(実表記)は座面必須");
  assertEqual(
    requiresSeatDimensions({ categoryName: "机", name: "北欧机 関連:チェア" }),
    false,
    "机カテゴリ(実表記)は座面対象外。商品名に関連語のチェアがあっても見ない",
  );
  // 「イス」の実装は「アイス」を誤検出しない(ア+イスの並びを除く)。
  assertEqual(
    requiresSeatDimensions({ categoryName: null, name: "アイスグレーの鏡" }),
    false,
    "商品名の「アイス」に含まれる「イス」を椅子と誤検出しない",
  );
}

const DESK_INPUT = {
  name: "北欧モダン ワークデスク",
  categoryName: "デスク",
  brand: null,
  width: null,
  depth: null,
  height: null,
  overallLength: null,
  seatDimensionsField: null,
  material: null,
  conditionRating: null,
  damageNotes: null,
  note: null,
  listingNotes: null,
  adminMemo: null,
};

function testSeatWarningScopedToSeatedFurniture() {
  // デスク: 座面寸法が無くても座面の警告を出さない(実際のユーザー報告)。
  const desk = buildListingFacts(DESK_INPUT);
  assertTrue(
    !desk.warnings.some((w) => w.includes("座面寸法")),
    "デスクは座面が無くて当然なので座面寸法の警告を出さない",
  );

  // 照明・テーブルも同様。
  const lighting = buildListingFacts({ ...DESK_INPUT, name: "北欧モダン フロアランプ", categoryName: "照明" });
  assertTrue(!lighting.warnings.some((w) => w.includes("座面寸法")), "照明は座面寸法の警告を出さない");
  const table = buildListingFacts({ ...DESK_INPUT, name: "北欧モダン ダイニングテーブル", categoryName: "テーブル" });
  assertTrue(!table.warnings.some((w) => w.includes("座面寸法")), "テーブルは座面寸法の警告を出さない");

  // 椅子・ソファは座面寸法が無ければ引き続き警告する。
  const chairNoSeat = buildListingFacts({ ...CHAIR_INPUT, seatDimensionsField: null, width: null, depth: null, height: null });
  assertTrue(
    chairNoSeat.warnings.some((w) => w.includes("座面寸法が登録されていません")),
    "椅子は座面寸法が全欠なら引き続き警告する",
  );
  const sofa = buildListingFacts({ ...CHAIR_INPUT, categoryName: "ソファ", seatDimensionsField: null });
  assertTrue(sofa.warnings.some((w) => w.includes("座面寸法が登録されていません")), "ソファも同様に警告する");

  // 一部だけ登録: 椅子・ソファでは「一部だけ」の警告。
  const partialSeat = buildListingFacts({ ...CHAIR_INPUT, seatDimensionsField: "高さ38" });
  assertTrue(
    partialSeat.warnings.some((w) => w.includes("座面寸法の一部だけが登録されています")),
    "座面寸法が一部だけなら一部警告を出す(椅子)",
  );
  assertTrue(partialSeat.warnings.some((w) => w.includes("幅・奥行")), "欠けている軸(幅・奥行)を名指しする");

  // 商品名に関連語(チェア等)が入っていても、カテゴリがデスクなら対象外。
  const deskWithChairWord = buildListingFacts({ ...DESK_INPUT, name: "チェアサイド ワークデスク" });
  assertTrue(
    !deskWithChairWord.warnings.some((w) => w.includes("座面寸法")),
    "商品名にチェアの語があってもカテゴリがデスクなら座面の警告を出さない",
  );

  // 全軸そろっている椅子は座面の警告そのものが出ない。
  const fullSeat = buildListingFacts(CHAIR_INPUT);
  assertTrue(!fullSeat.warnings.some((w) => w.includes("座面寸法")), "座面寸法が3軸そろっていれば警告なし");

  // レビュー対応: categoryName が実データどおりの業務区分(商品種別を
  // 示さない)でも、商品名から椅子と判定できれば座面警告が出ることを
  // buildListingFacts経由(実際に画面が使う経路)でも確認する。
  const businessCategoryChair = buildListingFacts({ ...CHAIR_INPUT, categoryName: "撮影待ち", seatDimensionsField: null });
  assertTrue(
    businessCategoryChair.warnings.some((w) => w.includes("座面寸法が登録されていません")),
    "業務区分カテゴリ(撮影待ち)でも商品名から椅子と判定して座面警告を出す",
  );
}

function testShippingWarningFollowsSelectedMethod() {
  // 寸法が無い(=どちらの配送方法でも確定できない)商品で、選択中の方法
  // だけに合わせて警告を出し分ける。
  const noDims = { ...CHAIR_INPUT, width: null, depth: null, height: null };

  const kazaiSelected = buildListingFacts({ ...noDims, shippingMethod: "KAZAI" });
  assertTrue(
    kazaiSelected.warnings.some((w) => w.includes("配送ランクを確定できません")),
    "らくらく家財便を選択中: 家財便の警告を出す",
  );
  assertTrue(
    !kazaiSelected.warnings.some((w) => w.includes("佐川急便のサイズを判定できません")),
    "らくらく家財便を選択中: 佐川の警告は出さない",
  );

  const sagawaSelected = buildListingFacts({ ...noDims, shippingMethod: "SAGAWA" });
  assertTrue(
    sagawaSelected.warnings.some((w) => w.includes("佐川急便のサイズを判定できません")),
    "佐川急便を選択中: 佐川の警告を出す",
  );
  assertTrue(
    !sagawaSelected.warnings.some((w) => w.includes("配送ランクを確定できません")),
    "佐川急便を選択中: 家財便の警告は出さない",
  );

  // 未指定は既定(らくらく家財便)として扱う —— canonical.ts の配送方法解決と同じ既定。
  const omitted = buildListingFacts(noDims);
  assertEqual(omitted.warnings, kazaiSelected.warnings, "配送方法を渡さなければ既定(らくらく家財便)として扱う");

  // ランク・サイズ自体はどちらの選択でも常に確定させる(表示・監査用)。
  // 切り替えても取り消し線にならないことを確かめる。
  const dims = { ...CHAIR_INPUT }; // 3辺合計178.5cm → 家財B / 佐川200
  const kazaiWithDims = buildListingFacts({ ...dims, shippingMethod: "KAZAI" });
  const sagawaWithDims = buildListingFacts({ ...dims, shippingMethod: "SAGAWA" });
  assertEqual(kazaiWithDims.shippingRank, sagawaWithDims.shippingRank, "配送方法の選択に関わらず家財便ランクは同じ値を返す");
  assertEqual(kazaiWithDims.sagawa.sizeClass?.size, sagawaWithDims.sagawa.sizeClass?.size, "配送方法の選択に関わらず佐川サイズは同じ値を返す");
}

/**
 * レビュー対応: ListingForm.tsx が生成後に画面の配送方法だけを切り替えた
 * ときに使う共通関数(buildShippingWarning / withCurrentShippingWarning)。
 * サーバーへ再問い合わせせずに、選んでいない方法の古い配送警告を残さない
 * ことをここで固定する(座面寸法等、配送に関係ない警告は残す)。
 */
function testShippingWarningReplacementFollowsMethodSwitch() {
  const noDims = { ...CHAIR_INPUT, width: null, depth: null, height: null, seatDimensionsField: null };

  // 生成時(らくらく家財便を選択中)は家財便の警告が入る。
  const generatedWithKazai = buildListingFacts({ ...noDims, shippingMethod: "KAZAI" });
  assertTrue(
    generatedWithKazai.warnings.some((w) => w.startsWith(KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX)),
    "生成時(家財便選択): 家財便の警告が入る",
  );

  // 生成後に画面だけ佐川へ切り替えた場合を模す(buildListingFactsを
  // 呼び直さない —— ListingForm.tsx と同じ経路)。
  const switchedToSagawa = buildShippingWarning({
    shippingMethod: "SAGAWA",
    sagawaUnavailableReason: generatedWithKazai.sagawa.unavailableReason,
    sagawaNote: generatedWithKazai.sagawa.note,
    shippingRankReason: generatedWithKazai.shippingRankReason,
  });
  const afterSwitch = withCurrentShippingWarning(generatedWithKazai.warnings, switchedToSagawa);

  assertTrue(
    !afterSwitch.some((w) => w.startsWith(KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX)),
    "配送方法切り替え後: 家財便の古い警告は残らない",
  );
  assertTrue(
    afterSwitch.some((w) => w.startsWith(SAGAWA_UNAVAILABLE_WARNING_PREFIX)),
    "配送方法切り替え後: 佐川の警告に差し替わる",
  );
  assertTrue(
    afterSwitch.some((w) => w.includes("座面寸法が登録されていません")),
    "配送方法切り替え後も配送に関係ない警告(座面寸法)はそのまま残す(警告を手抜きで全部消さない)",
  );

  // 逆方向(佐川 → 家財便)でも同様に差し替わる。
  const generatedWithSagawa = buildListingFacts({ ...noDims, shippingMethod: "SAGAWA" });
  const switchedToKazai = buildShippingWarning({
    shippingMethod: "KAZAI",
    sagawaUnavailableReason: generatedWithSagawa.sagawa.unavailableReason,
    sagawaNote: generatedWithSagawa.sagawa.note,
    shippingRankReason: generatedWithSagawa.shippingRankReason,
  });
  const afterSwitchBack = withCurrentShippingWarning(generatedWithSagawa.warnings, switchedToKazai);
  assertTrue(
    !afterSwitchBack.some((w) => w.startsWith(SAGAWA_UNAVAILABLE_WARNING_PREFIX)),
    "逆方向(佐川→家財便)切り替え後: 佐川の古い警告は残らない",
  );
  assertTrue(
    afterSwitchBack.some((w) => w.startsWith(KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX)),
    "逆方向(佐川→家財便)切り替え後: 家財便の警告に差し替わる",
  );

  // 寸法がそろっている商品は、切り替えてもどちらの配送警告も出ない。
  const generatedWithDims = buildListingFacts({ ...CHAIR_INPUT, shippingMethod: "KAZAI" });
  const noWarningAfterSwitch = withCurrentShippingWarning(
    generatedWithDims.warnings,
    buildShippingWarning({
      shippingMethod: "SAGAWA",
      sagawaUnavailableReason: generatedWithDims.sagawa.unavailableReason,
      sagawaNote: generatedWithDims.sagawa.note,
      shippingRankReason: generatedWithDims.shippingRankReason,
    }),
  );
  assertTrue(
    !noWarningAfterSwitch.some(
      (w) => w.startsWith(KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX) || w.startsWith(SAGAWA_UNAVAILABLE_WARNING_PREFIX),
    ),
    "寸法が確定していれば、配送方法を切り替えても配送警告は出ない",
  );
}

function testMaterialUnknownDoesNotWarn() {
  const noMaterial = buildListingFacts({ ...CHAIR_INPUT, material: null });
  assertEqual(noMaterial.material, null, "材質未登録は値としてnullのまま(推測しない)");
  assertTrue(!noMaterial.warnings.some((w) => w.includes("材質")), "材質未登録は警告を出さない");

  const unknownMaterial = buildListingFacts({ ...CHAIR_INPUT, material: "不明" });
  assertEqual(unknownMaterial.material, null, "「不明」は値として採らない(既存挙動を維持)");
  assertTrue(!unknownMaterial.warnings.some((w) => w.includes("材質")), "材質「不明」も警告を出さない");
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
  testSagawaIgnoresWeight();
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

  console.log("\n── 追加指示 §1 配送方法の選択 ─────────────────────");
  testShippingMethodSwitching();

  console.log("\n── 追加指示 §5 コンディション表現の正規化 ─────────");
  testConditionPhrasing();
  testConditionPhrasingLocatedFragments();

  console.log("\n── §20/§21 Product Context ─────────────────────────");
  testListingFacts();

  console.log("\n── 2026-09-10追加指示: 警告の適用条件 ─────────────");
  testRequiresSeatDimensions();
  testSeatWarningScopedToSeatedFurniture();
  testShippingWarningFollowsSelectedMethod();
  testShippingWarningReplacementFollowsMethodSwitch();
  testMaterialUnknownDoesNotWarn();

  console.log("\n── §4/§27 商品説明全体 ─────────────────────────────");
  testComposeListingDescription();

  console.log("\n── §25 チャネル別formatter ─────────────────────────");
  testChannelFormatter();

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
