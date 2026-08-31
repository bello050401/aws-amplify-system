/**
 * 夜間統合指示書(2026-09-01) §4.4/§4.7/§4.9/§5.2/§7: 商品紹介文の抽出と、
 * 生成結果の事実安全性チェックの検証。外部サービスへは一切接続しない。
 *
 * Run with: npm run verify:product-intro
 *
 * ここで固定したいこと:
 *
 *  1. 「商品のご紹介」だけを取り出し、サイズ・状態・発送・注意事項といった
 *     定型セクションを混ぜない(混ぜるとAIがそれをスタイルとして学ぶ)。
 *  2. 取り出せなかったものを「とりあえず全文」で代用しない。
 *  3. 社内スコア・在庫数・SKU・他人の住所・事実に無いブランドが、
 *     顧客向けの文章へ出た場合に必ず検出する。
 *  4. 社内スコア(conditionRating)と顧客向け状態説明(damageNotes)を取り違えない。
 */
import { extractProductIntro, htmlToPlainText } from "@/lib/ai/productIntro/extract";
import { buildCustomerSafeFacts, isInternalConditionScore, looksLikePersonalData, type CustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { checkFactSafety, type FactSafetyViolationCode } from "@/lib/ai/productIntro/factSafety";
import { buildStyleCorpus, deriveStyleGuide, selectStyleExamples, buildStyleExamplesBlock, BELLO_STYLE_GUIDE_VERSION } from "@/lib/ai/productIntro/styleGuide";
import { buildListingUserPrompt } from "@/lib/ai/ecCopy";

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

/** 生成結果に指定の違反が含まれるか。 */
function hasViolation(codes: FactSafetyViolationCode[], code: FactSafetyViolationCode): boolean {
  return codes.includes(code);
}

const BASE_FACTS: CustomerSafeFacts = {
  name: "BoConcept Elba ラウンジチェア",
  dimensions: "幅80 × 奥行75 × 高さ70（cm）",
  categoryName: "チェア",
  conditionDisclosure: "座面に若干の使用感があります。",
  publicNote: null,
};

function check(output: string, facts: CustomerSafeFacts = BASE_FACTS, extra: { stockQuantity?: number | null; sku?: string | null } = {}) {
  const r = checkFactSafety({ output, facts, ...extra });
  return { ok: r.ok, codes: r.violations.map((v) => v.code) };
}

// ── §4.4: 「◎商品のご紹介」の抽出 ───────────────────────────────────

function testHeadingExtraction() {
  const exact = `◎商品のご紹介
BoConceptのElbaラウンジチェアです。ゆったりとした座り心地で、リビングの主役になります。

◎コンディション
座面に若干の使用感があります。`;
  const r1 = extractProductIntro(exact);
  assertTrue(r1.ok, "抽出: ◎商品のご紹介 の見出しから紹介文を取り出せる");
  if (r1.ok) {
    assertTrue(r1.intro.includes("BoConcept"), "抽出: 紹介文の本文が取れている");
    assertTrue(!r1.intro.includes("使用感"), "抽出: 次のセクション(コンディション)を含めない");
    assertTrue(!r1.intro.includes("◎コンディション"), "抽出: 次セクションの見出し自体も含めない");
  }

  // 装飾なしの見出し。
  const plain = `商品のご紹介
シンプルなオーク材のダイニングテーブルです。天板の木目が美しく、和洋どちらの空間にも馴染みます。

【サイズ】
幅140`;
  const r2 = extractProductIntro(plain);
  assertTrue(r2.ok, "抽出: 装飾記号の無い「商品のご紹介」でも取り出せる");
  if (r2.ok) assertTrue(!r2.intro.includes("幅140"), "抽出: 【サイズ】以降を含めない");

  // 全角スペース・コロン付き。
  const spaced = `■　商品のご紹介　：
北欧デザインのフロアランプです。やわらかな光が空間を包みます。

■　サイズ
高さ150cm`;
  const r3 = extractProductIntro(spaced);
  assertTrue(r3.ok, "抽出: 全角スペース・コロン・別の装飾記号の表記ゆれを吸収する");
  if (r3.ok) assertTrue(!r3.intro.includes("150"), "抽出: 表記ゆれがあっても次セクションで正しく切れる");

  // HTML見出し + <br>
  const html = `<h3>◎商品のご紹介</h3><p>ヴィンテージのチーク材キャビネットです。<br>経年による風合いが魅力です。</p><h3>◎配送について</h3><p>佐川急便</p>`;
  const r4 = extractProductIntro(html);
  assertTrue(r4.ok, "抽出: HTMLの見出し・<br>を含む説明文でも取り出せる");
  if (r4.ok) {
    assertTrue(r4.intro.includes("チーク材"), "抽出: HTMLタグを除去した本文が取れる");
    assertTrue(!r4.intro.includes("佐川急便"), "抽出: HTMLでも配送セクションを含めない");
  }

  assertEqual(htmlToPlainText("A<br>B<br/>C"), "A\nB\nC", "htmlToPlainText: <br>を改行にする");
  assertTrue(!htmlToPlainText("<p>x</p>").includes("<"), "htmlToPlainText: タグを除去する");
}

function testDividerExtraction() {
  // 本番Inventoryで実際に使われている書式。
  const real = `＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

ヤマギワのテーブルライト「Libra」
モダンテイストでシンプルながらも存在感のあるデザイン。
存在感があるため、お部屋のアクセントとして最適です。

＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿


【商品名】
ヤマギワ

【サイズ】
傘部分幅:34

【注意事項】
ノークレーム・ノーリターンでお願いします。`;
  const r = extractProductIntro(real);
  assertTrue(r.ok, "抽出: 罫線で囲まれたBELLOの実書式から紹介文を取り出せる");
  if (r.ok) {
    assertEqual(r.source, "DIVIDER", "抽出: 罫線由来と記録される");
    assertTrue(r.intro.includes("Libra"), "抽出: 導入部の本文が取れている");
    assertTrue(!r.intro.includes("【商品名】"), "抽出: 【商品名】以降を含めない");
    assertTrue(!r.intro.includes("34"), "抽出: サイズの数値を含めない");
    assertTrue(!r.intro.includes("ノークレーム"), "抽出: 注意事項の定型文を含めない");
  }
}

function testExtractionRejections() {
  assertEqual(extractProductIntro("").ok, false, "抽出: 空文字は失敗として返す");
  assertEqual(extractProductIntro(null).ok, false, "抽出: nullでも例外にせず失敗を返す");
  assertEqual(extractProductIntro(undefined).ok, false, "抽出: undefinedでも例外にせず失敗を返す");

  const r1 = extractProductIntro("短い");
  assertEqual(r1.ok, false, "抽出: 短すぎる文章は採用しない");

  // 紹介文が無く定型文だけ —— 全文をスタイル資料にしてはいけない。
  const boilerplateOnly = `＿＿＿＿＿＿＿＿＿

＊画像にて判断でお願いします。
ノークレーム・ノーリターンでお願いします。
佐川急便にて東京から発送します。
すべての発送に保険加入しています。

＿＿＿＿＿＿＿＿＿`;
  const r2 = extractProductIntro(boilerplateOnly);
  assertEqual(r2.ok, false, "抽出: 定型文しか無い範囲は紹介文として採用しない");
  if (!r2.ok) assertEqual(r2.reason, "ONLY_BOILERPLATE", "抽出: 定型文だけの場合の理由が記録される");

  // 社内情報が混ざった塊 —— 実データで実際に取れてしまった形。
  const contaminated = `販売価格25,000別

コンディション4.0
天板は研磨をして、オイル塗装を施しております。
非常に綺麗なコンディションです。

【発送】
佐川急便`;
  const r3 = extractProductIntro(contaminated);
  assertEqual(r3.ok, false, "抽出: 社内の販売価格・コンディションスコアが混ざった塊は採用しない");
  if (!r3.ok) assertEqual(r3.reason, "INTERNAL_CONTAMINATION", "抽出: 社内情報混入の理由が記録される");

  // 見出しも罫線もセクションも無い、ただの一文
  const r4 = extractProductIntro("これは普通の備考です。特に構造がありません。");
  assertEqual(r4.ok, false, "抽出: 構造の無いただの備考は紹介文として採用しない");
  if (!r4.ok) assertEqual(r4.reason, "NO_INTRO_SECTION", "抽出: 特定できなかった理由が記録される");
}

// ── §4.7: 事実の組み立て(社内スコアと顧客向け説明の取り違え防止) ────

function testFactBuilding() {
  assertTrue(isInternalConditionScore("4"), "社内スコア判定: \"4\"はスコア");
  assertTrue(isInternalConditionScore("3.5"), "社内スコア判定: \"3.5\"はスコア");
  assertTrue(isInternalConditionScore("４"), "社内スコア判定: 全角数字もスコア");
  assertTrue(!isInternalConditionScore("座面に傷あり"), "社内スコア判定: 説明文はスコアではない");
  assertTrue(!isInternalConditionScore(null), "社内スコア判定: nullはスコアではない");

  // 実データの分布そのままの値で確認する。
  for (const v of ["3.5", "4", "3", "5", "2.5", "4.5", "4.0"]) {
    const { facts, redactions } = buildCustomerSafeFacts({ name: "テスト椅子", conditionRating: v, damageNotes: "小傷あり" });
    assertTrue(
      !JSON.stringify(facts).includes(v),
      `事実組み立て: conditionRating="${v}"(社内スコア)は顧客向け事実へ出さない`,
    );
    assertTrue(
      redactions.some((r) => r.field === "conditionRating" && r.reason === "INTERNAL_SCORE"),
      `事実組み立て: conditionRating="${v}"を落としたことが記録される`,
    );
    assertEqual(facts.conditionDisclosure, "小傷あり", `事実組み立て: 顧客向けの状態説明はdamageNotesから取る(conditionRating="${v}")`);
  }

  // conditionRatingが本物の説明文だった場合は、damageNotesが無ければ使ってよい。
  const withText = buildCustomerSafeFacts({ name: "テスト", conditionRating: "全体的に良好ですが脚部に擦り傷があります。" });
  assertEqual(withText.facts.conditionDisclosure, "全体的に良好ですが脚部に擦り傷があります。", "事実組み立て: conditionRatingが説明文ならそれを使う");

  // note に住所が入っている実例の形。
  const withAddress = buildCustomerSafeFacts({
    name: "油絵 抽象画",
    note: "００３－０８３２\n北海道 札幌市白石区北郷二条 7丁目1-30 ラフェールナナ302号\n\n絵画１点のみの出品です。",
  });
  assertEqual(withAddress.facts.publicNote, null, "事実組み立て: 住所らしき記述を含むnoteは丸ごと落とす");
  assertTrue(
    withAddress.redactions.some((r) => r.field === "note" && r.reason === "POSSIBLE_PERSONAL_DATA"),
    "事実組み立て: noteを落とした理由が記録される",
  );

  const cleanNote = buildCustomerSafeFacts({ name: "テスト", note: "モデルルーム展示品として入荷しました。" });
  assertEqual(cleanNote.facts.publicNote, "モデルルーム展示品として入荷しました。", "事実組み立て: 問題の無いnoteはそのまま使う");

  const dims = buildCustomerSafeFacts({ name: "テスト", width: "80", depth: "75", height: "70" });
  assertEqual(dims.facts.dimensions, "幅80 × 奥行75 × 高さ70（cm）", "事実組み立て: 寸法を1つの文字列へ整形する");
  assertEqual(buildCustomerSafeFacts({ name: "テスト" }).facts.dimensions, null, "事実組み立て: 寸法が無ければnull(捏造しない)");
}

function testPersonalDataDetection() {
  assertTrue(looksLikePersonalData("〒003-0832 北海道札幌市白石区"), "個人情報検出: 郵便番号+住所");
  assertTrue(looksLikePersonalData("００３－０８３２"), "個人情報検出: 全角の郵便番号");
  assertTrue(looksLikePersonalData("東京都渋谷区神南 1丁目2-3"), "個人情報検出: 都道府県+区+丁目");
  assertTrue(looksLikePersonalData("連絡先 090-1234-5678"), "個人情報検出: 電話番号");
  assertTrue(!looksLikePersonalData("幅80 × 奥行75 × 高さ70"), "個人情報検出: 寸法を住所と誤判定しない");
  assertTrue(!looksLikePersonalData("北欧モダンのサイドテーブルです。"), "個人情報検出: 普通の紹介文を誤判定しない");
  assertTrue(!looksLikePersonalData(null), "個人情報検出: nullでも例外にしない");
}

// ── §4.9/§5.2: 生成結果の機械検査 ───────────────────────────────────

function testFactSafetyObservedDefects() {
  // 実際に報告された3つの不具合。
  const condition = check("BoConcept Elba ラウンジチェアです。コンディションは4です。");
  assertTrue(!condition.ok, "検査: 「コンディションは4です」を不合格にする");
  assertTrue(hasViolation(condition.codes, "INTERNAL_CONDITION_SCORE"), "検査: 社内スコア露出として分類する");

  const stock = check("ゆったりとした座り心地のチェアです。在庫は2点あります。");
  assertTrue(!stock.ok, "検査: 「在庫は2点あります」を不合格にする");
  assertTrue(hasViolation(stock.codes, "STOCK_DISCLOSURE"), "検査: 在庫数露出として分類する");

  const brand = check("BoConceptのElba Lounge Chairです。関連ブランドにはムートやHAYがあります。");
  assertTrue(!brand.ok, "検査: 事実に無い「ムート/HAY」への言及を不合格にする");
  assertTrue(hasViolation(brand.codes, "UNSUPPORTED_BRAND"), "検査: 未裏付けブランドとして分類する");

  // 同じブランドでも、事実に含まれていれば正当。
  const hayFacts: CustomerSafeFacts = { ...BASE_FACTS, name: "HAY REVOLVER バースツール" };
  const hayOk = check("HAYのREVOLVERバースツールです。シンプルで洗練された佇まいです。", hayFacts);
  assertTrue(hayOk.ok, "検査: 商品名にあるブランド(HAY)への言及は正当なので通す");
}

function testFactSafetyOtherRules() {
  // 社内スコアの表記ゆれ。
  for (const bad of ["状態: 3.5", "コンディション4です", "コンディションランク4", "5段階評価で4", "状態は3です。"]) {
    const r = check(`素敵な椅子です。${bad}`);
    assertTrue(hasViolation(r.codes, "INTERNAL_CONDITION_SCORE"), `検査: 社内スコアの表記ゆれ「${bad}」を検出する`);
  }
  // 在庫の表記ゆれ。
  for (const bad of ["在庫は2点あります", "残り3点となっております", "在庫数 5個"]) {
    const r = check(`素敵な椅子です。${bad}`);
    assertTrue(hasViolation(r.codes, "STOCK_DISCLOSURE"), `検査: 在庫露出の表記ゆれ「${bad}」を検出する`);
  }

  const sku = check("素敵な椅子です。BLO-12345をご確認ください。", BASE_FACTS, { sku: "BLO-12345" });
  assertTrue(hasViolation(sku.codes, "SKU_OR_MANAGEMENT_ID"), "検査: 在庫ID(SKU)の露出を検出する");

  const pii = check("素敵な椅子です。発送元は東京都渋谷区神南 1丁目2-3です。");
  assertTrue(hasViolation(pii.codes, "PERSONAL_DATA"), "検査: 住所らしき記述を検出する");

  const heading = check("素敵な椅子です。\n【発送】\n佐川急便にて発送します。");
  assertTrue(hasViolation(heading.codes, "SECTION_HEADING_CONTAMINATION"), "検査: 定型セクション見出しの混入を検出する");

  const leak = check("厳守事項:\n- 与えられていない事実を推測して書かない。");
  assertTrue(hasViolation(leak.codes, "PROMPT_LEAKAGE"), "検査: プロンプト指示文の混入を検出する");

  const empty = check("   ");
  assertTrue(hasViolation(empty.codes, "EMPTY_OUTPUT"), "検査: 空の生成結果を不合格にする");

  const tooLong = check("あ".repeat(1300));
  assertTrue(hasViolation(tooLong.codes, "TOO_LONG"), "検査: 長すぎる生成結果を不合格にする");

  const repeated = check(["とても良い状態のチェアです。", "とても良い状態のチェアです。", "とても良い状態のチェアです。"].join("\n"));
  assertTrue(hasViolation(repeated.codes, "EXCESSIVE_REPETITION"), "検査: 同一文の繰り返しを検出する");

  // 正常な生成結果は通る。
  const good = check(
    "BoConceptのElbaラウンジチェアです。ゆったりとした座り心地と、丸みのあるフォルムが特徴で、リビングでも書斎でも空間になじみます。座面には若干の使用感がありますが、日常使いには支障のない状態です。",
  );
  assertTrue(good.ok, "検査: 事実に忠実で内部情報を含まない文章は通る");
  assertEqual(good.codes, [], "検査: 問題の無い文章では違反が0件");
}

function testFactSafetyDoesNotOverBlock() {
  // 寸法の数値は「在庫数」でも「スコア」でもない。
  const dims = check("幅80 × 奥行75 × 高さ70cmのゆったりとしたサイズです。");
  assertTrue(dims.ok, "検査: 寸法の数値を在庫数・スコアと誤検出しない");

  // 「3人掛け」のような仕様の数値。
  const seats = check("3人掛けのゆったりとしたソファです。リビングの主役になります。");
  assertTrue(seats.ok, "検査: 「3人掛け」のような仕様の数値を誤検出しない");

  // 事実にあるブランドの複数回言及。
  const repeatBrand = check("BoConceptのラウンジチェアです。BoConceptらしい洗練されたデザインが魅力です。");
  assertTrue(repeatBrand.ok, "検査: 事実にあるブランドを何度言及しても問題にしない");
}

// ── 商品名の社内マーカー・金額の除去(実データ由来) ──────────────────

function testInternalMarkerRemoval() {
  // 実データにあった形をそのまま使う。
  const cases: Array<{ input: string; mustNotContain: string[]; mustContain: string }> = [
    { input: "【兄】ヤマギワ テーブルランプ Libra SS226B ブラック", mustNotContain: ["兄", "【"], mustContain: "ヤマギワ" },
    { input: "【在庫1】Bello Select サイドテーブル ガラステーブル", mustNotContain: ["在庫1", "【"], mustContain: "サイドテーブル" },
    { input: "【林田様確定】北欧 モダン チェア", mustNotContain: ["林田", "様", "【"], mustContain: "チェア" },
    { input: "【伊藤様】ダイニングテーブル", mustNotContain: ["伊藤", "【"], mustContain: "ダイニングテーブル" },
    { input: "【井口へ売却】USM ハラー シェルフ", mustNotContain: ["井口", "売却", "【"], mustContain: "ハラー" },
    { input: "【指定なし：住所注意備考欄】油絵 抽象画 壁掛け アート", mustNotContain: ["住所", "【"], mustContain: "油絵" },
    { input: "【7/1午後】Vitra ヴィトラ Ad Hoc ダイニングテーブル", mustNotContain: ["7/1", "【"], mustContain: "Vitra" },
    { input: "【2/9納品確定：セット販売】ソファ 2人掛け", mustNotContain: ["納品", "【"], mustContain: "ソファ" },
  ];
  for (const c of cases) {
    const { facts, redactions } = buildCustomerSafeFacts({ name: c.input });
    for (const bad of c.mustNotContain) {
      assertTrue(!facts.name.includes(bad), `商品名の社内マーカー除去: ${JSON.stringify(c.input.slice(0, 24))} から ${JSON.stringify(bad)} を除く`);
    }
    assertTrue(facts.name.includes(c.mustContain), `商品名の社内マーカー除去: 商品本体の情報 ${JSON.stringify(c.mustContain)} は残す`);
    assertTrue(
      redactions.some((r) => r.field === "name" && r.reason === "INTERNAL_MARKER"),
      `商品名の社内マーカー除去: 除去したことが記録される (${JSON.stringify(c.input.slice(0, 20))})`,
    );
  }

  // マーカーが無い商品名はそのまま。
  const plain = buildCustomerSafeFacts({ name: "HAY REVOLVER BAR STOOL HIGH" });
  assertEqual(plain.facts.name, "HAY REVOLVER BAR STOOL HIGH", "商品名の社内マーカー除去: マーカーが無ければ変更しない");
  assertTrue(!plain.redactions.some((r) => r.field === "name"), "商品名の社内マーカー除去: 変更が無ければ記録もしない");

  // 【】しか無い異常な名前は、空にせず元へ戻す(生成が成立しなくなるため)。
  const onlyMarker = buildCustomerSafeFacts({ name: "【兄】" });
  assertTrue(onlyMarker.facts.name.length > 0, "商品名の社内マーカー除去: 除去して空になる場合は元の名前を残す");
}

function testPriceRedaction() {
  // 実データにあった形。
  const priced = buildCustomerSafeFacts({ name: "テーブルランプ", note: "定価42000円販売価格18000円送料込み" });
  assertEqual(priced.facts.publicNote, null, "金額の除去: 金額だけのnoteは空になる");
  assertTrue(priced.redactions.some((r) => r.field === "note" && r.reason === "PRICE"), "金額の除去: 除去したことが記録される");

  // 商品情報と金額が混在する場合、金額の行だけ落として残りは活かす。
  const mixed = buildCustomerSafeFacts({
    name: "ソファ",
    note: "モデルルーム展示品として入荷しました。\n定価180000円\nイタリア製の本革を使用しています。",
  });
  assertTrue(mixed.facts.publicNote !== null, "金額の除去: 金額以外の情報が残る場合はnoteを丸ごと落とさない");
  assertTrue(!(mixed.facts.publicNote ?? "").includes("180000"), "金額の除去: 金額の行は落とす");
  assertTrue((mixed.facts.publicNote ?? "").includes("モデルルーム"), "金額の除去: 商品情報の行は残す");

  // 「円形」を金額と誤検出しない。
  const enkei = buildCustomerSafeFacts({ name: "テーブル", note: "円形のガラス天板が特徴です。" });
  assertEqual(enkei.facts.publicNote, "円形のガラス天板が特徴です。", "金額の除去: 「円形」を金額と誤検出しない");
}

function testPersonNameAndPriceViolations() {
  const person = check("素敵なチェアです。林田様よりお譲りいただきました。");
  assertTrue(hasViolation(person.codes, "PERSON_NAME"), "検査: 個人名(◯◯様)の露出を検出する");

  const price = check("素敵なチェアです。定価42000円のところ18000円でご提供します。");
  assertTrue(hasViolation(price.codes, "PRICE_CLAIM"), "検査: 事実に無い金額の主張を検出する");

  // 事実として金額を渡している場合は通す。
  const withPriceFact: CustomerSafeFacts = { ...BASE_FACTS, publicNote: "参考上代 42000円" };
  const okPrice = checkFactSafety({ output: "ゆったりとした座り心地のチェアです。参考上代は42000円です。", facts: withPriceFact });
  assertTrue(
    !okPrice.violations.some((v) => v.code === "PRICE_CLAIM"),
    "検査: 事実として渡した金額への言及は通す",
  );

  // 「円形」を金額と誤検出しない。
  const enkei = check("円形のガラス天板が美しいサイドテーブルです。空間に軽やかさをもたらします。");
  assertTrue(!hasViolation(enkei.codes, "PRICE_CLAIM"), "検査: 「円形」を金額と誤検出しない");

  // 「奥様」のような一般語を個人名と誤検出しないこと(敬称の前が姓でない場合)。
  const general = check("お客様のお部屋に自然になじむデザインです。落ち着いた佇まいが魅力です。");
  assertTrue(!hasViolation(general.codes, "PERSON_NAME"), "検査: 「お客様」を個人名と誤検出しない");
}

// ── §4.5/§4.6: スタイル資料と few-shot 選択 ─────────────────────────

function testStyleCorpusAndSelection() {
  const rows = [
    { id: "a", name: "ヤマギワ テーブルランプ Libra", description: "＿＿＿＿＿＿\n\nヤマギワのテーブルライトです。モダンで存在感のあるデザインが魅力です。\n\n＿＿＿＿＿＿\n\n【サイズ】\n幅34" },
    { id: "b", name: "北欧 サイドテーブル 円形", description: "＿＿＿＿＿＿\n\nシンプルな天板とフレームでモダンな雰囲気を演出しています。リビングや玄関に最適です。\n\n＿＿＿＿＿＿\n\n【発送】\n佐川急便" },
    // 抽出できないもの(構造が無い)
    { id: "c", name: "何かの椅子", description: "普通の備考です。" },
    // 社内情報混じり —— corpusへ入れてはいけない
    { id: "d", name: "汚染された商品", description: "販売価格25,000別\n\nコンディション4.0\n天板は研磨をして、オイル塗装を施しております。\n\n【発送】\n佐川急便" },
    { id: "e", name: "説明が無い商品", description: null },
  ];
  const { examples, stats } = buildStyleCorpus(rows);
  assertEqual(examples.length, 2, "corpus: 紹介文を取り出せたものだけがcorpusへ入る");
  assertEqual(stats.attempted, 4, "corpus: 説明文が空のものは試行に数えない");
  assertTrue(!examples.some((e) => e.inventoryId === "d"), "corpus: 社内情報が混ざった商品はcorpusへ入れない");
  assertTrue((stats.failures.INTERNAL_CONTAMINATION ?? 0) >= 1, "corpus: 社内情報混入の失敗が記録される");
  assertTrue(examples.every((e) => !e.intro.includes("【")), "corpus: 定型セクションの見出しがcorpusへ入らない");

  const guide = deriveStyleGuide(examples, stats);
  assertEqual(guide.version, BELLO_STYLE_GUIDE_VERSION, "style guide: versionが付く(プロンプトの再現性を追えるように)");
  assertTrue(guide.averageLength > 0, "style guide: 平均文字数を算出する");
  assertTrue(guide.positivePatterns.length > 0, "style guide: 望ましい書き方が列挙される");
  assertTrue(
    guide.prohibitedPatterns.some((p) => p.includes("関連ブランド")),
    "style guide: 実際に観測された不具合(関連ブランドの列挙)が禁止事項に入っている",
  );
  assertTrue(
    guide.prohibitedPatterns.some((p) => p.includes("在庫")),
    "style guide: 在庫数への言及が禁止事項に入っている",
  );

  // few-shot選択
  const corpus = [
    { inventoryId: "1", name: "北欧 サイドテーブル 円形 ガラス", intro: "サイドテーブルの紹介文です。".repeat(3) },
    { inventoryId: "2", name: "ヤマギワ テーブルランプ", intro: "ランプの紹介文です。".repeat(3) },
    { inventoryId: "3", name: "USM ハラー シェルフ", intro: "シェルフの紹介文です。".repeat(3) },
  ];
  const picked = selectStyleExamples({ targetName: "北欧 モダン サイドテーブル 円形", examples: corpus, limit: 2 });
  assertEqual(picked.length, 2, "few-shot: 指定した件数だけ選ぶ(全corpusを送らない)");
  assertEqual(picked[0].inventoryId, "1", "few-shot: 商品名が近いものを優先する");

  // 自分自身は手本にしない。
  const self = selectStyleExamples({ targetName: "USM ハラー シェルフ", examples: corpus, limit: 3 });
  assertTrue(!self.some((e) => e.name === "USM ハラー シェルフ"), "few-shot: 同じ商品名の文章を自分の手本にしない");

  // 文字数の上限を超えない。
  const budget = selectStyleExamples({ targetName: "テーブル", examples: corpus, limit: 3, maxTotalChars: 20 });
  assertEqual(budget.length, 0, "few-shot: 文字数の予算を超える例は載せない");

  // 空corpusでも壊れない。
  assertEqual(selectStyleExamples({ targetName: "テーブル", examples: [], limit: 3 }).length, 0, "few-shot: corpusが空でも例外にしない");

  // プロンプトブロックが「事実の出典ではない」ことを前後で明示する。
  const block = buildStyleExamplesBlock(picked);
  assertTrue(block.includes("事実の出典ではありません"), "few-shot: 文体例が事実の出典でないことを明示する");
  assertTrue(block.includes("文体例はここまで"), "few-shot: 例の終わりを明示し、以降は事実だけだと念を押す");
  assertTrue(
    block.includes("ブランド名") && block.includes("持ち込んではいけません"),
    "few-shot: 過去商品のブランド名等を新商品へ持ち込まないよう明示する",
  );
  assertEqual(buildStyleExamplesBlock([]), "", "few-shot: 例が無ければブロックを作らない");
}

function testStyleExamplesInPrompt() {
  // §4.8: プロンプトが「文体例」と「今回の事実」に分かれていること。
  const withStyle = buildListingUserPrompt({
    name: "BoConcept Elba ラウンジチェア",
    conditionNote: "座面に使用感あり",
    styleExamplesBlock: "【文体例1】\n過去の紹介文です。",
  });
  assertTrue(withStyle.includes("【文体例1】"), "プロンプト: 文体例が含まれる");
  assertTrue(withStyle.includes("確認できている事実"), "プロンプト: 事実のセクションが明示される");
  assertTrue(
    withStyle.indexOf("【文体例1】") < withStyle.indexOf("確認できている事実"),
    "プロンプト: 文体例より後に事実が来る(直近の指示として事実が効くように)",
  );

  const withoutStyle = buildListingUserPrompt({ name: "テスト椅子" });
  assertTrue(!withoutStyle.includes("文体例"), "プロンプト: 文体例が無ければそのセクションを作らない");
  assertTrue(withoutStyle.includes("商品名: テスト椅子"), "プロンプト: 事実は常に含まれる");
}

async function main() {
  testHeadingExtraction();
  testDividerExtraction();
  testExtractionRejections();
  testFactBuilding();
  testPersonalDataDetection();
  testFactSafetyObservedDefects();
  testFactSafetyOtherRules();
  testFactSafetyDoesNotOverBlock();
  testInternalMarkerRemoval();
  testPriceRedaction();
  testPersonNameAndPriceViolations();
  testStyleCorpusAndSelection();
  testStyleExamplesInPrompt();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
