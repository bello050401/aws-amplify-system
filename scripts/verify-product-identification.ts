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

testUrlExtraction();
testBasis();
testUrlRequest();
testTemplate();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
