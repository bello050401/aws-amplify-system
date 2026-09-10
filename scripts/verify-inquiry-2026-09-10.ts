/**
 * 2026-09-10 追加指示: 問い合わせ返信の実用性改善の検証。
 *
 * 対象:
 *   - lib/inquiry/prompt.ts   … 新設した4つの方針(型番食い違い/過去の
 *     個別対応の一般化禁止/重量の一般論断定禁止/追加写真等の断定禁止)が
 *     実際にプロンプト文字列へ入ること。
 *   - lib/inquiry/validate.ts … 根拠の無い重量の検出(FABRICATED_WEIGHT)。
 *     単位を伴う値としての正規化(500g根拠で500kgを拒否/0.5kgを許容/
 *     寸法の数値(mm)を重量の根拠にしない)を含む(2026-09-10 QA是正)。
 *   - lib/inquiry/pipeline.ts … identifyResearchableFields が
 *     knownFields を尊重して重複調査(課金)を起こさないこと、かつ
 *     知っている属性で質問が満たされた場合に抽象的な「仕様」検索へ
 *     fallbackしないこと(2026-09-10 QA是正)。detectModelNumberMismatch が
 *     型番の食い違いを正しく判定すること(ラベル付きの短い型番は見逃さず、
 *     ラベル無しの短い一般語は誤検出しない。2026-09-10 QA是正)。
 *
 * すべて匿名の合成fixtureのみを使う。実際の顧客文面・識別情報は一切
 * 含めない(指示書§5「顧客原文や識別情報は一切渡していないため検索/収集
 * しない」)。
 *
 * 実行方法: このworktreeには node_modules が無く、npm run 系は使えない
 * (memory: qa-worktree-tooling-limits)。tsx等が入った通常の開発環境では
 * `npm run verify:inquiry-2026-09-10` で実行する。
 *
 * このworktree内では、node_modulesを必要としない代替ローダー
 * .scratch-ts-loader.mjs(タスク差分には含めない。使い方は完了報告参照)
 * 経由で `node --experimental-transform-types --experimental-loader
 * ./.scratch-ts-loader.mjs scripts/verify-inquiry-2026-09-10.ts` として
 * 実行し、実際に確認した。
 *
 * 【2026-09-10 再検収での追記】以前はここで identifyResearchableFields /
 * detectModelNumberMismatch を pipeline.ts から直接importできず、同じ
 * ロジックを手で転記した鏡像関数で代替していた(pipeline.ts の import
 * チェーンが "server-only" や @aws-sdk/* 等、未インストールの外部パッケージ
 * に依存するため)。上記の代替ローダーがそれらを最小限のスタブへ解決する
 * ようになったことで、pipeline.ts を直接importできるようになったため、
 * 鏡像の再実装はやめ、以下は実コードを直接importして検証する
 * (scripts/verify-inquiry.ts の testModelNumberMismatchDetection /
 * identifyResearchableFields のknownFields系テストと合わせて、実コードでの
 * 二重の裏付けになる)。
 */
import { buildInquirySystemPrompt } from "../lib/inquiry/prompt";
import { validateReplyDraft } from "../lib/inquiry/validate";
import { extractLabelledModelNumbers, extractModelNumbers } from "../lib/inquiry/references";
import { detectModelNumberMismatch, identifyResearchableFields } from "../lib/inquiry/pipeline";
import type { CustomerSafeFacts } from "../lib/ai/productIntro/facts";

let failures = 0;
let passes = 0;
function assertTrue(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`✗ FAIL ${label}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

// ── prompt.ts: 新設した4方針が実際にプロンプトへ入ること ────────────
function testNewSystemPromptPolicies() {
  const system = buildInquirySystemPrompt();
  assertTrue(
    system.includes("食い違う場合、一致する・間違いないと書かない"),
    "system prompt: 型番等の食い違いを勝手に一致と書かせない指示がある",
  );
  assertTrue(
    system.includes("社内で現物を確認する旨"),
    "system prompt: 型番食い違いは社内の現物確認へ回す指示がある",
  );
  assertTrue(
    system.includes("過去の個別対応") && system.includes("今回の商品にも同じように適用できると仮定しない"),
    "system prompt: 過去の個別対応(値引き・送料無料等)を全商品方針に転用しない指示がある",
  );
  assertTrue(
    system.includes("性別や体格についての一般論") && system.includes("安全性を断定しない"),
    "system prompt: 重量不明を性別・一般論で安全断定しない指示がある",
  );
  assertTrue(
    system.includes("写真の送付可否・写真番号・枚数・清掃状況"),
    "system prompt: 追加写真の可否・写真番号・清掃状況を断定しない指示がある",
  );
}

// ── validate.ts: 根拠の無い重量の検出 ───────────────────────────────
const BASE_FACTS: CustomerSafeFacts = {
  name: "テストチェア",
  dimensions: null,
  categoryName: "チェア",
  conditionDisclosure: null,
  publicNote: null,
};

function testWeightFabrication() {
  // 根拠が無いのに重量を書いた場合は不合格になる。
  const noEvidence = validateReplyDraft({
    output: "本体重量は約12.5kgです。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [],
    externalTexts: [],
    allowedDimensionText: [],
    allowedWeightText: [],
  });
  assertTrue(!noEvidence.ok, "重量検査: 根拠の無い重量(12.5kg)は不合格になる");
  assertTrue(
    noEvidence.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査: 不合格理由が FABRICATED_WEIGHT である",
  );

  // 根拠(allowedWeightText)にある重量はそのまま書いてよい。
  const withEvidence = validateReplyDraft({
    output: "本体重量は約12.5kgです。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [],
    externalTexts: [],
    allowedDimensionText: [],
    allowedWeightText: ["12.5kg"],
  });
  assertTrue(
    !withEvidence.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査: allowedWeightTextにある重量(12.5kg)はFABRICATED_WEIGHTにならない",
  );

  // 重量にまったく触れていなければ、当然どちらの検査にも掛からない。
  const noMention = validateReplyDraft({
    output: "サイズについては確認のうえご案内いたします。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [{ field: "重量", reason: "商品説明・在庫DBに記載がありません。" }],
    externalTexts: [],
    allowedDimensionText: [],
    allowedWeightText: [],
  });
  assertTrue(
    !noMention.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査: 重量に触れていない返信はFABRICATED_WEIGHTにならない",
  );

  // ── 2026-09-10 QA是正: 単位を伴う値としての比較 ────────────────
  //
  // 根拠は「500g」。同じ重さでも単位が違う「500kg」(1000倍重い、別物)は
  // 引き続き拒否しなければならない。旧実装は数値だけをSet化していたため、
  // 単位を無視して「500」同士が一致し、誤って許可されていた。
  const kgVsGMismatch = validateReplyDraft({
    output: "本体重量は約500kgです。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [],
    externalTexts: [],
    allowedDimensionText: [],
    allowedWeightText: ["500g"],
  });
  assertTrue(
    kgVsGMismatch.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査(QA是正): 根拠が500gのとき、単位違いの500kgは拒否される",
  );

  // 根拠「500g」に対し、同じ重さの言い換えである「0.5kg」は許可されなければ
  // ならない。旧実装は数値表記(500 と 0.5)が違うという理由だけで拒否していた。
  const gToKgEquivalent = validateReplyDraft({
    output: "本体重量は約0.5kgです。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [],
    externalTexts: [],
    allowedDimensionText: [],
    allowedWeightText: ["500g"],
  });
  assertTrue(
    !gToKgEquivalent.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査(QA是正): 根拠が500gのとき、同じ重さの言い換えである0.5kgは許可される",
  );

  // 根拠文中の別の寸法(500mm)を重量の根拠として使わない。allowedWeightTextに
  // 「500mm」しか無い(kg/gの単位が無い)場合、500gという重量表記は
  // 引き続き根拠無しとして拒否されなければならない。
  const dimensionNotTreatedAsWeight = validateReplyDraft({
    output: "本体重量は約500gです。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [],
    externalTexts: [],
    allowedDimensionText: ["500mm"],
    allowedWeightText: ["梱包時の目安寸法は500mm程度です。"],
  });
  assertTrue(
    dimensionNotTreatedAsWeight.violations.some((v) => v.code === "FABRICATED_WEIGHT"),
    "重量検査(QA是正): 根拠文中の寸法(500mm)を重量(500g)の根拠に使わない",
  );
}

// ── validate.ts: 未解決「型番」の断定を検出(既存ASSERTED_UNRESOLVED_FACT
//    が、pipeline.ts の型番食い違い検出と組み合わさったときに機能すること) ──
function testModelNumberUnresolvedAssertion() {
  const assertsMatch = validateReplyDraft({
    output: "お問い合わせの型番は当店の商品と一致しております。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [{ field: "型番", reason: "お客様が挙げた型番が把握している型番と一致しません。社内で現物を確認してください。" }],
    externalTexts: [],
    allowedDimensionText: [],
  });
  assertTrue(!assertsMatch.ok, "型番食い違い: 未解決の型番を断定した返信は不合格になる");
  assertTrue(
    assertsMatch.violations.some((v) => v.code === "ASSERTED_UNRESOLVED_FACT"),
    "型番食い違い: 不合格理由がASSERTED_UNRESOLVED_FACTである",
  );

  const hedged = validateReplyDraft({
    output: "型番については社内で確認のうえ改めてご案内いたします。",
    facts: BASE_FACTS,
    allowedShippingFeeYen: null,
    unresolved: [{ field: "型番", reason: "お客様が挙げた型番が把握している型番と一致しません。社内で現物を確認してください。" }],
    externalTexts: [],
    allowedDimensionText: [],
  });
  assertTrue(
    !hedged.violations.some((v) => v.code === "ASSERTED_UNRESOLVED_FACT"),
    "型番食い違い: 「確認のうえ」とヘッジした返信は断定とみなされない",
  );
}

// ── pipeline.ts: identifyResearchableFields / detectModelNumberMismatch
//    (実コードを直接import。上のコメント参照) ──────────────────────

function testResearchSkipsKnownFields() {
  const facts: CustomerSafeFacts = { ...BASE_FACTS, dimensions: null };
  const withoutKnown = identifyResearchableFields(["MATERIAL"], true, facts, "素材は何ですか", new Set());
  assertTrue(withoutKnown.includes("素材"), "外部調査: 既知情報が無ければ素材を調査対象にする(従来どおり)");

  const withKnown = identifyResearchableFields(["MATERIAL"], true, facts, "素材は何ですか", new Set(["素材"]));
  assertTrue(
    !withKnown.includes("素材"),
    "外部調査: BASE商品説明から素材が分かっている場合、重ねて外部調査(課金)を発動しない",
  );

  // ── 2026-09-10 QA是正: knownFieldsで質問が満たされたら「仕様」へ
  //    fallbackしない ────────────────────────────────────────────
  //
  // 素材はknownFieldsで分かっている(satisfiedByKnownFields=true)。それでも
  // 旧実装は fields.length===0 のみを見て PRODUCT_SPEC から「仕様」を
  // 追加していたため、既に答えを持っているのに抽象的な外部調査(課金)を
  // 発動していた。
  const materialKnownWithProductSpec = identifyResearchableFields(
    ["MATERIAL", "PRODUCT_SPEC"],
    true,
    facts,
    "素材は何ですか",
    new Set(["素材"]),
  );
  assertTrue(
    materialKnownWithProductSpec.length === 0,
    "外部調査(QA是正): 素材が既知でPRODUCT_SPEC意図が付いていても、抽象的な「仕様」検索へfallbackしない",
  );

  // 一方、質問が2つの属性(素材=既知、耐荷重=未知)にまたがる場合は、
  // 未知の側(耐荷重)だけを引き続き調査対象にする —— knownFieldsは
  // 「全部わかっている」ときだけ調査を止めるべきで、一部だけ既知でも
  // 残りの調査を握りつぶしてはいけない。
  const partiallyKnown = identifyResearchableFields(
    ["PRODUCT_SPEC"],
    true,
    facts,
    "素材と耐荷重を教えてください",
    new Set(["素材"]),
  );
  assertTrue(
    partiallyKnown.includes("耐荷重") && !partiallyKnown.includes("素材") && !partiallyKnown.includes("仕様"),
    "外部調査(QA是正): 一部の属性だけ既知の場合、未知の属性(耐荷重)は引き続き調査対象にする",
  );
}

function testModelNumberMismatchDetection() {
  assertTrue(
    detectModelNumberMismatch({ customerModelNumbers: ["XYZ999"], ownModelNumbers: ["SS226B"] }) === true,
    "型番食い違い判定: 手持ちの型番と一致しなければ食い違いと判定する",
  );
  assertTrue(
    detectModelNumberMismatch({ customerModelNumbers: ["SS-226B"], ownModelNumbers: ["SS226B"] }) === false,
    "型番食い違い判定: ハイフンの有無だけの表記ゆれは食い違いと判定しない",
  );
  assertTrue(
    detectModelNumberMismatch({ customerModelNumbers: ["ABC123"], ownModelNumbers: [] }) === false,
    "型番食い違い判定: こちらの型番情報が無ければ「知らない」であり「食い違い」ではない",
  );
  assertTrue(
    detectModelNumberMismatch({ customerModelNumbers: [], ownModelNumbers: ["SS226B"] }) === false,
    "型番食い違い判定: 顧客が型番を挙げていなければ判定しない",
  );

  // ── 2026-09-10 QA是正: ラベル付きの短い型番を見逃さない ───────────
  //
  // 「型番：A2」のように明示的にラベル付きで書かれた2文字の型番(家具にも
  // ある)。旧実装は一律「3文字未満は誤検出が多い」という理由で除外し、
  // この食い違いを見逃していた。
  assertTrue(
    detectModelNumberMismatch({
      customerModelNumbers: [],
      customerLabelledModelNumbers: ["A3"],
      ownModelNumbers: [],
      ownLabelledModelNumbers: ["A2"],
    }) === true,
    "型番食い違い判定(QA是正): ラベル付きの短い型番(A2 vs A3)の食い違いを見逃さない",
  );
  // 一致していれば当然、食い違いにはならない。
  assertTrue(
    detectModelNumberMismatch({
      customerModelNumbers: [],
      customerLabelledModelNumbers: ["A2"],
      ownModelNumbers: [],
      ownLabelledModelNumbers: ["A2"],
    }) === false,
    "型番食い違い判定(QA是正): ラベル付きの短い型番が一致していれば食い違いと判定しない",
  );

  // ── 2026-09-10 QA是正: ラベル無しの短い一般語を型番として誤検出しない ──
  //
  // 顧客本文にラベル無しで現れた短い英数字混じりの語(例: "P2"のような
  // 商品説明と無関係な語)は、customerModelNumbers(ラベル無し)側に
  // 入っていても3文字未満は引き続き除外され、判定の対象にならない。
  assertTrue(
    detectModelNumberMismatch({
      customerModelNumbers: ["P2"],
      ownModelNumbers: ["SS226B"],
    }) === false,
    "型番食い違い判定(QA是正): ラベル無しの短い語(P2)は型番として扱わず誤検出しない",
  );
}

// ── references.ts: extractLabelledModelNumbers(実コードを直接実行) ──
//
// pipeline.ts と違い references.ts は外部パッケージ依存が無いため、
// ここは再実装ではなく実コードをそのままimportして検証できる。
function testExtractLabelledModelNumbers() {
  assertTrue(
    extractLabelledModelNumbers("型番：A2です").includes("A2"),
    "型番ラベル抽出: 「型番：A2」のようなラベル付きの短い値を拾う",
  );
  assertTrue(
    extractLabelledModelNumbers("AW-0573の素材は何ですか").length === 0,
    "型番ラベル抽出: ラベルが無ければ(助詞が続く等)拾わない",
  );
  assertTrue(
    extractModelNumbers("AW-0573の素材は何ですか").includes("AW-0573"),
    "型番抽出(従来どおり): ラベル無しでも英数字混じりの語は拾う(長さで別途絞る)",
  );
}

testNewSystemPromptPolicies();
testWeightFabrication();
testModelNumberUnresolvedAssertion();
testResearchSkipsKnownFields();
testModelNumberMismatchDetection();
testExtractLabelledModelNumbers();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
