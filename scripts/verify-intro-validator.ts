/**
 * 「◎商品のご紹介」に寸法を書かせない検査の回帰テスト
 * (2026-09-02 指示書§4/§5/§22)。
 *
 * 固定ケースは指示書が実際の失敗例として挙げた文章そのもの。
 *
 *   Anonymous Lounge Chair / プロ仕上げ モダン パーソナルチェア …。
 *   幅72 × 奥行71 × 高さ81（cm）のサイズで、ゆったりとくつろげるデザインです。
 *
 * Run with: npm run verify:intro-validator
 */
import {
  findGenericPhrases,
  findIntroDimensionViolations,
  isIntroStillUsable,
  stripDimensionSentences,
  MAX_GENERIC_PHRASES,
  MIN_INTRO_LENGTH_AFTER_STRIP,
} from "@/lib/ai/productPage/introValidator";

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

const FAILING_INTRO =
  "Anonymous Lounge Chair / プロ仕上げ モダン パーソナルチェア ラウンジチェア 1人掛けソファ。\n" +
  "幅72 × 奥行71 × 高さ81（cm）のサイズで、ゆったりとくつろげるデザインです。\n" +
  "厚みのあるクッションとゆるやかに湾曲した背もたれが、腰かけたときに背中全体を支えます。" +
  "木部は落ち着いたトーンで仕上げられており、張地の質感と組み合わさって静かな存在感があります。" +
  "書斎の読書用の椅子としても、寝室の窓辺に置く一脚としても収まりの良い大きさです。";

function testDetectsFixedFailureCase() {
  const v = findIntroDimensionViolations(FAILING_INTRO);
  assertTrue(v.length > 0, "指示書の失敗例を検出する");
  assertTrue(
    v.some((x) => x.kind === "AXIS_LABEL"),
    "「幅72」を軸ラベル付き寸法として検出する",
  );
  assertTrue(
    v.some((x) => x.kind === "MULTIPLIED"),
    "「72 × 奥行71」を掛け算表記として検出する",
  );
  assertTrue(
    v.some((x) => x.kind === "UNIT"),
    "「（cm）」付きの数値を検出する",
  );
}

function testDetectsSeatAndArmDimensions() {
  assertTrue(findIntroDimensionViolations("SH45の座り心地").some((v) => v.kind === "SEAT_OR_ARM"), "SH45");
  assertTrue(findIntroDimensionViolations("AH65です").some((v) => v.kind === "SEAT_OR_ARM"), "AH65");
  assertTrue(findIntroDimensionViolations("座面高44cm").some((v) => v.kind === "SEAT_OR_ARM"), "座面高44");
  assertTrue(findIntroDimensionViolations("肘掛高65").some((v) => v.kind === "SEAT_OR_ARM"), "肘掛高65");
  assertTrue(findIntroDimensionViolations("3辺合計224").some((v) => v.kind === "THREE_SIDE_SUM"), "3辺合計224");
  assertTrue(findIntroDimensionViolations("720mm").some((v) => v.kind === "UNIT"), "720mm");
  assertTrue(findIntroDimensionViolations("Ｗ７２").length > 0, "全角の Ｗ７２ も検出する");
}

function testDoesNotOverBlock() {
  // 数字が出るだけでは弾かない。弾きたいのは寸法であって数字ではない。
  assertEqual(findIntroDimensionViolations("3人掛けのソファです。"), [], "「3人掛け」は寸法ではない");
  assertEqual(findIntroDimensionViolations("2灯のペンダントライトです。"), [], "「2灯」は寸法ではない");
  assertEqual(findIntroDimensionViolations("1960年代のデザインです。"), [], "年代は寸法ではない");
  assertEqual(findIntroDimensionViolations("型番はHD1080です。"), [], "型番のH+数字を軸ラベルと誤認しない");
  assertEqual(findIntroDimensionViolations("北欧デザインの椅子です。"), [], "数字が無ければ何も検出しない");
  assertEqual(findIntroDimensionViolations(""), [], "空文字");
  assertEqual(findIntroDimensionViolations(null), [], "null");
}

function testStripsDimensionSentences() {
  const r = stripDimensionSentences(FAILING_INTRO);
  assertEqual(r.stillViolating, [], "除去後は寸法が残らない");
  assertEqual(r.removedSentences.length, 1, "落としたのは寸法を含む1文だけ");
  assertTrue(r.text.includes("厚みのあるクッション"), "寸法と無関係な文は残る");
  assertTrue(!r.text.includes("幅72"), "寸法の文は消える");
  assertTrue(isIntroStillUsable(r.text), "除去後も紹介文として成立している");

  // 寸法しか書かれていない紹介文は、除去すると成立しない ——
  // その場合は「そのまま採用」ではなく失敗にする必要がある。
  const onlyDimensions = stripDimensionSentences("幅72 × 奥行71 × 高さ81（cm）です。");
  assertEqual(onlyDimensions.stillViolating, [], "寸法だけの文も除去はできる");
  assertTrue(!isIntroStillUsable(onlyDimensions.text), "残りが短すぎる場合は採用不可と判定する");
  assertTrue(MIN_INTRO_LENGTH_AFTER_STRIP > 0, "採用可否の下限が定義されている");
}

function testGenericPhrases() {
  const generic =
    "ゆったりとくつろげるデザインです。リビングやラウンジにもぴったり。" +
    "洗練された佇まいが、お部屋のアクセントとして空間を演出します。";
  const found = findGenericPhrases(generic);
  assertTrue(found.length > MAX_GENERIC_PHRASES, `テンプレ表現が多い文章を検出する(${found.length}件)`);

  const specific =
    "座面と背もたれを一枚の成形合板で繋いだ構造で、脚部は細いスチールに置き換えられています。" +
    "木目は縦方向に通っており、正面から見たときの輪郭がまっすぐに見えます。";
  assertTrue(findGenericPhrases(specific).length <= MAX_GENERIC_PHRASES, "商品固有の説明はテンプレ判定に引っかからない");
}

function main() {
  testDetectsFixedFailureCase();
  testDetectsSeatAndArmDimensions();
  testDoesNotOverBlock();
  testStripsDimensionSentences();
  testGenericPhrases();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
