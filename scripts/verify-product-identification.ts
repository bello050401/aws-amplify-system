/**
 * 商品特定と「URLを尋ねるか」の判定を固定する検証。
 * ネットワークにもAWSにも繋がない。
 *
 * ── 背景（実測） ────────────────────────────────────────────────
 *
 * BASE商品URL → 商品ID の抽出は**もともと正しく動いていた**
 * （scripts/probe-base-url-resolution.ts で14通り、失敗0件）。
 * 壊れていたのはその先で、`BaseProductArchive` が267件しか無く、
 * 指示書の実例 156144635 が入っていないため商品名が得られず、
 * 「該当なし」になっていた。
 *
 * ここではURL抽出の回帰と、特定できなかったときにURLを尋ねる判定を
 * 固定する。
 *
 * Run with: npm run verify:product-identification
 */
import { extractBaseItemId, extractUrls, isBaseUrl, extractProductReferences } from "@/lib/inquiry/references";
import {
  PRODUCT_URL_REQUEST_TEMPLATE,
  canAnswerProductSpecifics,
  decideUrlRequest,
  identificationBasis,
  linkedBaseProduct,
  type IdentificationBasis,
} from "@/lib/inquiry/productIdentification";

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
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

const ID = "156144635";
const URL = `https://bellointeri.base.shop/items/${ID}`;

/* ══════════════════════════════════════════════════════════════════
 * 1. URL から商品ID（指示書が挙げたパターンすべて）
 * ══════════════════════════════════════════════════════════════════ */
function testUrlExtraction() {
  const idsIn = (text: string) => [
    ...new Set(
      extractUrls(text)
        .filter(isBaseUrl)
        .map(extractBaseItemId)
        .filter((v): v is string => v !== null),
    ),
  ];

  assertEqual(idsIn(URL), [ID], "URL: 通常");
  assertEqual(idsIn(`${URL}/`), [ID], "URL: 末尾スラッシュ");
  assertEqual(idsIn(`${URL}?utm_source=line`), [ID], "URL: クエリ付き");
  assertEqual(idsIn(`${URL}。`), [ID], "URL: 末尾に句点");
  assertEqual(idsIn(`（${URL}）`), [ID], "URL: 括弧で囲まれている");
  assertEqual(idsIn(`${URL}、サイズは？`), [ID], "URL: 末尾に読点＋文章");
  assertEqual(
    idsIn(`こちらの商品について確認したいです。\n${URL}\nサイズを教えてください。`),
    [ID],
    "URL: 前後に文章（指示書の例）",
  );
  assertEqual(idsIn(`${URL} と ${URL}`), [ID], "URL: 同じURLが2回でも1件");
  assertEqual(
    idsIn(`${URL} と https://bellointeri.base.shop/items/155832757`),
    [ID, "155832757"],
    "URL: 複数URLは両方",
  );
  assertEqual(idsIn("https://example.com/items/999999999"), [], "URL: BASE以外は拾わない");
  assertEqual(idsIn(`https://example.com/items/111 と ${URL}`), [ID], "URL: BASE以外が混ざってもBASEだけ");
  assertEqual(idsIn("アンティークチェアについて"), [], "URL: URLなし");
  assertEqual(idsIn(URL.replace("https://", "http://")), [ID], "URL: httpスキーム");
  assertEqual(idsIn(URL.replace("bellointeri", "BelloInteri")), [ID], "URL: ホストの大文字小文字を問わない");
  assertEqual(idsIn("https://bellointeri.base.shop/items/abc"), [], "URL: 数字でないIDは拾わない");
  assertEqual(idsIn("https://bellointeri.base.shop/about"), [], "URL: 商品ページ以外は拾わない");

  // 入口の関数からも同じ結果になること。
  assertEqual(extractProductReferences(`${URL} について`, []).baseItemIds, [ID], "URL: 入口の関数でも同じID");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 何を根拠に特定したか
 * ══════════════════════════════════════════════════════════════════
 * 確信度ではなく**根拠の種類**で分ける。商品名の一致だけで高い確信度が
 * 出ても、同名・類似商品があれば別物かもしれない。
 */
const noRefs = { baseItemIds: [], skus: [], inventoryIds: [], modelNumbers: [] };

function testBasis() {
  assertEqual(
    identificationBasis({ status: "RESOLVED", references: { ...noRefs, baseItemIds: [ID] }, candidateCount: 1 }),
    "BASE_ITEM_ID",
    "根拠: 商品URLのIDで決まった",
  );
  assertEqual(
    identificationBasis({ status: "RESOLVED", references: { ...noRefs, skus: ["B005611"] }, candidateCount: 1 }),
    "STRONG_CODE",
    "根拠: SKUで決まった",
  );
  assertEqual(
    identificationBasis({ status: "RESOLVED", references: noRefs, candidateCount: 1, fromOperatorOrConversation: true }),
    "OPERATOR_OR_CONVERSATION",
    "根拠: 担当者が選んだ／会話に紐づいている",
  );
  assertEqual(
    identificationBasis({ status: "RESOLVED", references: noRefs, candidateCount: 1 }),
    "NAME_ONLY",
    "根拠: 商品名だけで決まった（確信度が高くても別扱い）",
  );
  assertEqual(
    identificationBasis({ status: "AMBIGUOUS", references: { ...noRefs, baseItemIds: [ID] }, candidateCount: 3 }),
    "NONE",
    "根拠: RESOLVED でなければ根拠なし",
  );

  // URLとSKUが両方あるならURLを優先する（より直接的な指定）。
  assertEqual(
    identificationBasis({
      status: "RESOLVED",
      references: { ...noRefs, baseItemIds: [ID], skus: ["B005611"] },
      candidateCount: 1,
    }),
    "BASE_ITEM_ID",
    "根拠: URLとSKUが両方あればURLを優先",
  );

  const answerable: [IdentificationBasis, boolean][] = [
    ["BASE_ITEM_ID", true],
    ["STRONG_CODE", true],
    ["OPERATOR_OR_CONVERSATION", true],
    ["NAME_ONLY", false],
    ["NONE", false],
  ];
  for (const [b, ok] of answerable) {
    assertEqual(canAnswerProductSpecifics(b), ok, `回答可否: ${b} → ${ok ? "答えてよい" : "答えない"}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 3. URLを尋ねるかどうか
 * ══════════════════════════════════════════════════════════════════ */
function testUrlRequest() {
  const d = (over: Partial<Parameters<typeof decideUrlRequest>[0]>) =>
    decideUrlRequest({
      basis: "NONE",
      status: "NOT_FOUND",
      candidateCount: 0,
      requiresProduct: true,
      ...over,
    });

  // 特定できている → 尋ねない（不要な確認をしない）
  assertEqual(
    d({ basis: "BASE_ITEM_ID", status: "RESOLVED", candidateCount: 1 }).requestUrl,
    false,
    "URL依頼: URLで特定済みなら尋ねない",
  );
  assertEqual(
    d({ basis: "STRONG_CODE", status: "RESOLVED", candidateCount: 1 }).requestUrl,
    false,
    "URL依頼: SKUで特定済みなら尋ねない",
  );
  assertEqual(
    d({ basis: "OPERATOR_OR_CONVERSATION", status: "RESOLVED", candidateCount: 1 }).requestUrl,
    false,
    "URL依頼: 会話に紐づく商品なら尋ねない",
  );

  // 商品名だけ → 尋ねる（RESOLVED でも）
  const nameOnly = d({ basis: "NAME_ONLY", status: "RESOLVED", candidateCount: 1 });
  assertEqual(nameOnly.requestUrl, true, "URL依頼: 商品名だけならRESOLVEDでも尋ねる");
  assertTrue(nameOnly.reason.includes("商品名"), "URL依頼: 理由に「商品名だけ」と書かれる");

  const manyCandidates = d({ basis: "NAME_ONLY", status: "RESOLVED", candidateCount: 4 });
  assertTrue(manyCandidates.reason.includes("4件"), "URL依頼: 類似候補の件数を理由に含める");

  // 候補が複数 / 見つからない / 手がかりなし → 尋ねる
  assertEqual(d({ status: "AMBIGUOUS", candidateCount: 3 }).requestUrl, true, "URL依頼: 候補が複数なら尋ねる");
  assertEqual(d({ status: "NOT_FOUND" }).requestUrl, true, "URL依頼: 一致する在庫が無ければ尋ねる");
  assertEqual(d({ status: "NOT_REFERENCED" }).requestUrl, true, "URL依頼: 手がかりが無ければ尋ねる");

  // 商品が要らない問い合わせ → 尋ねない
  assertEqual(
    d({ status: "NOT_REFERENCED", requiresProduct: false }).requestUrl,
    false,
    "URL依頼: 商品が決まらなくても答えられる問い合わせでは尋ねない",
  );
  assertEqual(
    d({ basis: "NAME_ONLY", status: "RESOLVED", candidateCount: 2, requiresProduct: false }).requestUrl,
    false,
    "URL依頼: 商品名だけでも、商品不要の質問なら尋ねない",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 依頼文
 * ══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
 * §4 内部の商品特定失敗を顧客へ転嫁しない
 *
 * メルカリShopsのメール経由では、顧客は既に商品ページから問い合わせて
 * いる。商品URLを送れる導線がそもそも無いのに「URLをお送りください」と
 * 返すのは、BELLO側で紐付けられなかっただけの失敗を顧客の手間へ
 * 押し付けることになる。実際にその返信案が8件生成されていた。
 * ══════════════════════════════════════════════════════════════════ */
function testNoUrlRequestWhereImpossible() {
  const base = {
    basis: "NAME_ONLY" as IdentificationBasis,
    status: "NOT_FOUND" as const,
    candidateCount: 0,
    requiresProduct: true,
  };

  // 既定(URLを送れる経路)では従来どおり尋ねる。
  assertTrue(decideUrlRequest(base).requestUrl, "URL依頼: 送れる経路では従来どおり尋ねる");

  // 送れない経路では尋ねない。
  const noUrl = decideUrlRequest({ ...base, customerCanProvideUrl: false });
  assertTrue(!noUrl.requestUrl, "URL依頼: 顧客がURLを送れない経路では尋ねない(§4)");
  assertTrue(noUrl.reason.includes("社内"), "URL依頼: 代わりに社内で確認する旨を理由に書く");

  // 候補が複数のときも同じ。
  assertTrue(
    !decideUrlRequest({ ...base, status: "AMBIGUOUS", candidateCount: 3, customerCanProvideUrl: false }).requestUrl,
    "URL依頼: 候補が複数でも、送れない経路では尋ねない",
  );

  // 商品が特定できていれば、そもそも尋ねない(経路に関係なく)。
  assertTrue(
    !decideUrlRequest({ ...base, basis: "BASE_ITEM_ID", status: "RESOLVED", customerCanProvideUrl: false }).requestUrl,
    "URL依頼: 特定済みなら尋ねない",
  );
}

function testTemplate() {
  const t = PRODUCT_URL_REQUEST_TEMPLATE;
  assertTrue(t.includes("URL"), "文面: URLを求めていると分かる");
  assertTrue(t.includes("お送りいただけますでしょうか"), "文面: 依頼の形になっている");
  assertTrue(t.includes("確認でき次第"), "文面: この後どうなるかを伝えている");
  // 商品を特定できていないのに、商品の話をしない。
  for (const word of ["価格", "値下げ", "サイズ", "寸法", "在庫あり", "送料"]) {
    assertTrue(!t.includes(word), `文面: 特定前なので「${word}」に触れない`);
  }
  assertTrue(!t.includes("？"), "文面: 詰問調にならない");
}

/* ══════════════════════════════════════════════════════════════════
 * 担当者向けカードに載せるBASE商品ページの選び方
 *
 * カードは仕入価格・販売開始日時まで出す。そこに別商品のページへの
 * 導線が並ぶと、担当者が「この商品の話だ」と信じたまま**別商品の
 * 条件で値下げを判断する**。結び付けられないときは出さない、を固定する。
 * ══════════════════════════════════════════════════════════════════ */
function testLinkedBaseProduct() {
  const a = { baseItemId: "156144635" };
  const b = { baseItemId: "155832757" };

  assertEqual(linkedBaseProduct("BASE_ITEM_ID", [a]), a, "BASE商品ページ: URL1件で特定できたら結び付ける");
  assertEqual(linkedBaseProduct("BASE_ITEM_ID", []), null, "BASE商品ページ: 該当のBASE商品が無ければ出さない");

  // 複数URL: 照合は全URLのタイトルをまとめて使うので、どのURLの商品に
  // 決まったのかは残っていない。先頭を採ると別商品を指しうる。
  assertEqual(linkedBaseProduct("BASE_ITEM_ID", [a, b]), null, "BASE商品ページ: URLが2件なら、どちらか決められないので出さない");

  // 担当者選択・会話紐付けで決まった商品は、同じ問い合わせにURLがあっても
  // そのURLが指す商品とは限らない（照合に失敗したURLがそのまま残る経路がある）。
  assertEqual(
    linkedBaseProduct("OPERATOR_OR_CONVERSATION", [a]),
    null,
    "BASE商品ページ: 担当者選択・会話紐付けで決まったなら、問い合わせ中のURLとは結び付けない",
  );
  for (const basis of ["STRONG_CODE", "NAME_ONLY", "NONE"] as IdentificationBasis[]) {
    assertEqual(linkedBaseProduct(basis, [a]), null, `BASE商品ページ: ${basis} では結び付けない`);
  }

  // 画面に出す「結び付けられなかった件数」— pipeline.ts と同じ式。
  const unlinked = (basis: IdentificationBasis, list: unknown[]) => list.length - (linkedBaseProduct(basis, list) ? 1 : 0);
  assertEqual(unlinked("BASE_ITEM_ID", [a]), 0, "未結合件数: URL1件で結び付いたら0件（注意を出さない）");
  assertEqual(unlinked("BASE_ITEM_ID", [a, b]), 2, "未結合件数: URL2件でどちらも結び付かなければ2件");
  assertEqual(unlinked("OPERATOR_OR_CONVERSATION", [a]), 1, "未結合件数: 会話紐付けの商品にURL1件が残れば1件");
  assertEqual(unlinked("NAME_ONLY", []), 0, "未結合件数: URLが無ければ0件");
}

testUrlExtraction();
testBasis();
testUrlRequest();
testNoUrlRequestWhereImpossible();
testTemplate();
testLinkedBaseProduct();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
