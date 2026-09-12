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
 *
 * インポートは相対パスで書く(`@/`エイリアスにしない)こと —— この検証
 * スクリプトは `node <mainrepo>/scripts/with-server-only-stub.cjs
 * <worktree>/scripts/verify-intro-validator.ts` のように、tsxの実行
 * cwdが本体repoのままworktree側のファイルを対象実行する構成で使われる。
 * tsxの`@/*`解決はcwd起点のtsconfigを見るため、`@/`のままだと
 * (worktree側の変更ではなく)本体repo側の同名ファイルへ解決されてしまい、
 * ここで検査したいworktreeの実装ではなく古い実装を読み込んで検査が
 * 無意味になる(2026-09-10 再検収でこれが原因の実行時TypeErrorとして
 * 顕在化した)。相対パスならファイル自身の場所基準で解決されるため、
 * cwdに関係なく常にこのworktreeの実装を読み込む。
 */
import { buildGuidanceBlock } from "../lib/ai/productPage/guidanceBlock";
import { buildProductPageUserPrompt } from "../lib/ai/productPage/prompt";
import {
  findCategoryMismatchViolations,
  findGenericPhrases,
  findIntroConditionViolations,
  findIntroDimensionViolations,
  inferProductFamily,
  isIntroStillUsable,
  stripCategoryMismatchSentences,
  stripConditionSentences,
  stripDimensionSentences,
  MAX_GENERIC_PHRASES,
  MIN_INTRO_LENGTH_AFTER_STRIP,
} from "../lib/ai/productPage/introValidator";

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

/**
 * 2026-09-02 追加仕様§4/§5: BELLO改善指示のプロンプトブロック。
 *
 * 事実のブロックと混ぜないこと、無効な指示を渡さないこと、優先順位が
 * 本文で明示されていることを固定する。
 */
function testGuidanceBlock() {
  assertEqual(buildGuidanceBlock([]), null, "指示が0件ならブロックを作らない");
  assertEqual(
    buildGuidanceBlock([{ instruction: "サイズを書かない", enabled: false }]),
    null,
    "無効な指示だけならブロックを作らない",
  );
  assertEqual(
    buildGuidanceBlock([{ instruction: "   ", enabled: true }]),
    null,
    "空白だけの指示は無視する",
  );

  const block = buildGuidanceBlock([
    { instruction: "商品のご紹介にはサイズを書かない", enabled: true },
    { instruction: "これは無効", enabled: false },
    { instruction: "汎用的なEC表現を減らす", enabled: true },
  ]);
  assertTrue(block !== null, "有効な指示があればブロックを作る");
  assertTrue(block!.includes("商品のご紹介にはサイズを書かない"), "有効な指示は入る");
  assertTrue(block!.includes("汎用的なEC表現を減らす"), "有効な指示は入る(2件目)");
  assertTrue(!block!.includes("これは無効"), "無効な指示は入らない");
  assertTrue(block!.includes("1. 商品のご紹介にはサイズを書かない"), "有効なものだけで番号を振り直す");
  assertTrue(block!.includes("2. 汎用的なEC表現を減らす"), "無効を飛ばして連番になる");

  // ここが本体。指示を「事実」として書き写されないための文言。
  assertTrue(block!.includes("事実ではない"), "これは事実ではない、と明示する");
  assertTrue(block!.includes("確定事実を優先"), "確定事実を優先すると明示する");
}

/**
 * §5 の優先順位が、プロンプトの並びとして実際に守られているか。
 *
 *   確定事実 > BELLO改善指示 > 類似BASE商品(見本)
 *
 * 事実が先頭にあること、改善指示が見本より後ろ(= より近く)にあること。
 */
function testProductPagePromptOrdering() {
  const facts = {
    name: "TEST CHAIR",
    dimensions: "幅50 奥行50 高さ80",
    categoryName: "チェア",
    conditionDisclosure: "小傷あり",
    publicNote: null,
  };
  const similar = [
    {
      reference: { baseItemId: "1", titleCore: "SAMPLE", brand: null, category: null, price: null, introText: "見本の紹介文です。" },
      score: 1,
      reasons: ["ブランド一致"],
    },
  ];
  const guidanceBlock = buildGuidanceBlock([{ instruction: "汎用表現を減らす", enabled: true }]);

  const prompt = buildProductPageUserPrompt({
    facts,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    similar: similar as any,
    shippingBoilerplate: null,
    guidanceBlock,
  });

  const factsAt = prompt.indexOf("今回の商品の事実情報");
  const sampleAt = prompt.indexOf("文体の見本");
  const guidanceAt = prompt.indexOf("書き方の指示");
  assertTrue(factsAt >= 0, "事実のブロックがある");
  assertTrue(sampleAt > factsAt, "見本は事実より後ろ");
  assertTrue(guidanceAt > sampleAt, "改善指示は見本より後ろ(= より強く効く位置)");
  assertTrue(prompt.includes("汎用表現を減らす"), "指示の本文が入る");

  // 指示が無ければブロックごと出ない(空の見出しを残さない)。
  const without = buildProductPageUserPrompt({
    facts,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    similar: similar as any,
    shippingBoilerplate: null,
    guidanceBlock: null,
  });
  assertTrue(!without.includes("書き方の指示"), "指示が無ければブロックを出さない");
}

/**
 * ── 「◎商品のご紹介」へのコンディション混入検査(2026-09-09 追加指示) ──
 *
 * レビュー修正指示: 既知傷情報を含む入力/情報欠損の入力の最低2ケースで、
 * この検査自体を実行してpassすることを示す。
 *
 * ケース1: TRUSTED_FACTS(conditionDisclosure)に実際の傷・錆の記載がある
 * 状態で、その語が紹介文へ漏れているケース(既知傷情報を含む入力)。
 */
function testDetectsConditionLeakWithKnownDamage() {
  const conditionDisclosure = "座面に薄い擦れ傷があります。長年の使用に伴うわずかな錆も見られます。";
  const introWithLeak =
    "北欧デザインらしい落ち着いた佇まいの一脚で、細身の木脚と丸みのあるフォルムが空間に軽さを添えます。" +
    "座面には薄い擦れ傷があり、長年の使用に伴うわずかな錆も見られますが、味わいとしてお楽しみいただけます。" +
    "木部の質感と張地の色合いが上品にまとまっており、リビングでもダイニングでも合わせやすいデザインで、来客の多いお宅にもおすすめです。";

  const violations = findIntroConditionViolations(introWithLeak, conditionDisclosure);
  assertTrue(violations.length > 0, "コンディション: TRUSTED_FACTSにある傷・錆の語が紹介文に漏れていれば検出する");
  assertTrue(violations.some((v) => v.keyword === "傷"), "コンディション: 「傷」の漏れを検出する");
  assertTrue(violations.some((v) => v.keyword === "錆"), "コンディション: 「錆」の漏れを検出する");

  // 漏れた文だけを落として、紹介文として成立するかを確認する
  // (stripDimensionSentencesと同じ「文ごと落とす」設計)。
  const stripped = stripConditionSentences(introWithLeak, conditionDisclosure);
  assertEqual(stripped.stillViolating, [], "コンディション: 除去後は傷・錆の語が残らない");
  assertTrue(stripped.removedSentences.length === 1, "コンディション: 落としたのはコンディションを含む1文だけ");
  assertTrue(stripped.text.includes("北欧デザインらしい"), "コンディション: 状態と無関係な文は残る");
  assertTrue(!stripped.text.includes("擦れ傷"), "コンディション: 状態の文は消える");
  assertTrue(isIntroStillUsable(stripped.text), "コンディション: 除去後も紹介文として成立している");
}

/**
 * ケース2: TRUSTED_FACTS側にコンディション情報が無い(情報欠損)入力。
 *
 * 紹介文に「傷」という字面がたまたま含まれていても(例: 慣用表現)、
 * その紹介文自体が個体の状態を言い切っていなければ「違反」を作り出さない
 * (過検知でAIの自然な文章まで壊さないため。2026-09-10 再検収以降は
 * disclosureとの一致ではなく、紹介文自身の言い回しで判定する ——
 * 下の testConditionNotationVariantAndMissingDisclosureFabrication 参照)。
 */
function testConditionMissingInfoDoesNotFabricateViolation() {
  const introWithIncidentalWord =
    "経年変化を味わいとして楽しめる、傷も含めて表情になる家具です。木部の質感が魅力的な一脚です。";

  assertEqual(
    findIntroConditionViolations(introWithIncidentalWord, null),
    [],
    "コンディション: 状態を言い切っていない字面の一致だけでは違反にしない(情報欠損時の過検知防止)",
  );
  assertEqual(
    findIntroConditionViolations(introWithIncidentalWord, ""),
    [],
    "コンディション: 空文字のconditionDisclosureでも同様に違反にしない",
  );
  assertEqual(findIntroConditionViolations(null, "座面に傷があります。"), [], "コンディション: 紹介文が無ければ何も検出しない");
  assertEqual(findIntroConditionViolations("傷ひとつありません。", "傷ひとつありません。"), [
    { keyword: "傷" },
  ], "コンディション: 「傷が無い」という開示も、その語自体が状態を言い切っていれば検出はする(文意の判定はしない軽量検査である旨の確認)");
}

/**
 * ── 2026-09-10 再検収: findIntroConditionViolations の3件の実修正 ──
 *
 * Codexの実測で見つかった、実関数への追加入力での不具合3件をそのまま
 * 固定ケースにする(プロンプトの文言だけを直して合格とする、という
 * 再発を防ぐため、実関数の入出力で確認する)。
 *
 *   1. 表記ゆれ(カタカナ/漢字)ですり抜ける:
 *      intro『脚にサビがあります。』/ disclosure『脚に錆』 → 旧実装は[]
 *   2. 情報無し(disclosure空)の状態創作ですり抜ける:
 *      intro『天板に小傷があります。』/ disclosure空 → 旧実装は[]
 *   3. 素材の一般性質を状態と誤判定:
 *      intro『傷に強い素材を採用しています。』/ disclosure『天板に傷』
 *      → 旧実装は[{keyword:"傷"}](誤検知)
 */
function testConditionNotationVariantAndMissingDisclosureFabrication() {
  // 1. 表記ゆれ(カタカナ/漢字)。
  const notationMismatch = findIntroConditionViolations("脚にサビがあります。", "脚に錆");
  assertTrue(notationMismatch.length > 0, "再検収1: 紹介文『サビ』/開示文『錆』の表記ゆれでも検出する");
  assertTrue(notationMismatch.some((v) => v.keyword === "サビ"), "再検収1: キーワード『サビ』として検出する");

  // 2. disclosureが空でも、紹介文が個体の状態を言い切っていれば検出する。
  const fabricatedWithoutDisclosure = findIntroConditionViolations("天板に小傷があります。", "");
  assertTrue(fabricatedWithoutDisclosure.length > 0, "再検収2: disclosureが空でも状態の言い切りは検出する(創作を見逃さない)");
  assertTrue(fabricatedWithoutDisclosure.some((v) => v.keyword === "傷"), "再検収2: キーワード『傷』として検出する");
  assertTrue(findIntroConditionViolations("天板に小傷があります。", null).length > 0, "再検収2: disclosureがnullでも検出する");

  // 3. 素材の一般的な性質の説明は、disclosureに同じ語があっても削除しない。
  const generalMaterialProperty = findIntroConditionViolations("傷に強い素材を採用しています。", "天板に傷");
  assertEqual(generalMaterialProperty, [], "再検収3: 『傷に強い素材』は個体の状態ではないので検出しない");
}

/**
 * 対照例: 正常な紹介文・典型的な状態の言い回し(天板の小傷・脚錆・
 * 色褪せ/変色)・過検知を避けたい一般表現をまとめて確認する。
 */
function testConditionRealWorldContrastCases() {
  // 正常な紹介文(状態の語を含まない)は何も検出しない。
  const normalIntro =
    "北欧デザインらしい落ち着いた佇まいの一脚で、細身の木脚と丸みのあるフォルムが空間に軽さを添えます。" +
    "木部の質感と張地の色合いが上品にまとまっており、リビングでもダイニングでも合わせやすいデザインです。";
  assertEqual(findIntroConditionViolations(normalIntro, null), [], "対照: 状態に触れない通常の紹介文は検出しない");

  // 天板の小傷・脚の錆は典型的な状態の言い切りなので検出する。
  assertTrue(
    findIntroConditionViolations("天板には小傷が見られます。", "天板に小傷").some((v) => v.keyword === "傷"),
    "対照: 天板の小傷は検出する",
  );
  assertTrue(
    findIntroConditionViolations("脚部に錆があります。", "脚部に錆あり").some((v) => v.keyword === "錆"),
    "対照: 脚の錆は検出する",
  );

  // 色褪せ・変色も同じ形で検出する。
  assertTrue(
    findIntroConditionViolations("背面には色褪せが見られます。", null).some((v) => v.keyword === "色褪せ"),
    "対照: 色褪せの言い切りは検出する",
  );
  assertTrue(
    findIntroConditionViolations("座面に変色があります。", null).some((v) => v.keyword === "変色"),
    "対照: 変色の言い切りは検出する",
  );

  // 経年変化を前向きに語るだけの表現(状態を言い切っていない)は
  // 過剰検知しない。
  assertEqual(
    findIntroConditionViolations("色あせも味わいとして楽しめる一脚です。", null),
    [],
    "対照: 状態を言い切っていない一般的な言い回しは検出しない(誤削除しない)",
  );

  // 汚れがつきにくい/耐傷仕様、のような素材の一般的な性質も同様。
  assertEqual(
    findIntroConditionViolations("汚れがつきにくい加工を施しています。", "座面に汚れ"),
    [],
    "対照: 『汚れがつきにくい加工』は性質の説明なので検出しない",
  );
  assertEqual(
    findIntroConditionViolations("耐傷仕様のガラス天板です。", "天板に傷"),
    [],
    "対照: 『耐傷仕様』は性質の説明なので検出しない",
  );
}

/**
 * ── カテゴリと矛盾する一般名称の検査(2026-09-11 追加指示) ──────────
 *
 * 報告された実例そのもの: 照明(カテゴリ「照明」)を「デザイナーズ家具」と
 * 呼んだ。寸法・コンディションの既存検査と同じ「文ごと検出→文ごと除去、
 * 成立しなければ失敗として扱う」の形で固定する。
 */
function testCategoryMismatchDetection() {
  assertEqual(inferProductFamily("照明"), "LIGHTING", "カテゴリ分類: 照明");
  assertEqual(inferProductFamily("ペンダントライト"), "LIGHTING", "カテゴリ分類: 照明の語のゆれ(ペンダントライト)");
  assertEqual(inferProductFamily("ソファ"), "FURNITURE", "カテゴリ分類: ソファ");
  assertEqual(inferProductFamily(null), null, "カテゴリ分類: 未設定なら判定しない(検査自体を行わない)");

  const reported = "ヤマギワのテーブルランプです。デザイナーズ家具としても人気のシリーズです。";
  const violations = findCategoryMismatchViolations(reported, "照明");
  assertTrue(violations.length > 0, "報告された実例(照明を「家具」と呼ぶ)を検出する");
  assertEqual(findCategoryMismatchViolations(reported, "ソファ"), [], "家具カテゴリなら「家具」の言及は矛盾しない");
  assertEqual(findCategoryMismatchViolations(reported, null), [], "カテゴリ未設定では検査しない(過検知しない)");

  // 店の自己紹介(「家具・什器」)は今回の商品個体を家具と呼んだことにはならない。
  const selfReference = "BELLOは中古家具・什器を扱うショップです。今回はヤマギワのテーブルランプをご紹介します。";
  assertEqual(findCategoryMismatchViolations(selfReference, "照明"), [], "「家具・什器」という店の自己紹介は誤検出しない");

  // 文ごと落として、成立するなら採用する(stripDimensionSentencesと同じ設計)。
  const withExtra =
    "ヤマギワのテーブルランプです。デザイナーズ家具としても人気のシリーズです。" +
    "存在感のある美しいフォルムが、空間にやわらかな灯りを添えます。" +
    "傘の部分にはすりガラスが使われており、点灯時には柔らかく拡散した光が広がります。書斎の机上でも、寝室のサイドテーブルの上でも収まりの良いサイズです。";
  const stripped = stripCategoryMismatchSentences(withExtra, "照明");
  assertEqual(stripped.stillViolating, [], "除去後はカテゴリ矛盾が残らない");
  assertTrue(!stripped.text.includes("家具"), "矛盾する文は消える");
  assertTrue(stripped.text.includes("存在感のある美しいフォルム"), "無関係な文は残る");
  assertTrue(isIntroStillUsable(stripped.text), "除去後も紹介文として成立している");
}

function main() {
  testGuidanceBlock();
  testProductPagePromptOrdering();
  testDetectsFixedFailureCase();
  testDetectsSeatAndArmDimensions();
  testDoesNotOverBlock();
  testStripsDimensionSentences();
  testGenericPhrases();
  testDetectsConditionLeakWithKnownDamage();
  testConditionMissingInfoDoesNotFabricateViolation();
  testConditionNotationVariantAndMissingDisclosureFabrication();
  testConditionRealWorldContrastCases();
  testCategoryMismatchDetection();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
