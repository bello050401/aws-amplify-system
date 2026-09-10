/**
 * 問い合わせ返信プロンプト(lib/inquiry/prompt.ts)の回帰テスト
 * (2026-09-09 追加指示: 「遅延ではなく、送信に使える文章品質が不足している」)。
 *
 * 実AI呼び出しはしない。純粋関数である buildInquirySystemPrompt /
 * buildInquiryUserPrompt に、架空の TRUSTED_FACTS / UNRESOLVED の
 * fixture を渡して組み立てられるプロンプト文字列だけを検査する。
 *
 * 3シナリオそれぞれについて:
 *   (a) 該当する質問に触れる指示・事実がプロンプトに含まれること
 *   (b) 断定禁止ガード(推測で書かない/TRUSTED_FACTSに無いことは書かない等)
 *       が機能する形でプロンプトに含まれること
 * を確認する。
 *
 * Run with:
 *   node --input-type=module -e "..." (scripts/with-server-only-stub.cjs は
 *   node_modules/tsx が無いこのworktreeでは使えないため、
 *   memory: qa-worktree-tooling-limits の registerHooks 手法で直接実行する)
 *   または: node <mainrepo>/scripts/with-server-only-stub.cjs
 *     <このworktree>/scripts/verify-inquiry-prompt-fixtures.ts (tsx利用)。
 *   この形式ではtsxの`@/*`解決がcwd(=mainrepo)基準になるため、下の
 *   インポートは相対パスで書く —— `@/`のままだと本体repo側の同名ファイル
 *   へ解決され、worktreeでの変更が検査対象から外れてしまう
 *   (2026-09-10 再検収: verify-intro-validatorで実際に踏んだ不具合と同じ)。
 */
import { buildInquirySystemPrompt, buildInquiryUserPrompt } from "../lib/inquiry/prompt";

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

// ── シナリオ1: 架空の送料問い合わせ(お届け先未確定) ──────────────────
//
// 実データ・実在庫は使わない架空のfixture。都道府県が分からず送料が
// 確定していない状態を UNRESOLVED / shipping.feeYen=null で表す。
function testShippingInquiryScenario() {
  const system = buildInquirySystemPrompt();
  const user = buildInquiryUserPrompt({
    intents: ["SHIPPING"],
    trustedProductFacts: [{ label: "サイズ", value: "幅80 × 奥行75 × 高さ70（cm）" }],
    knowledgeExcerpts: [],
    shipping: {
      destinationPrefecture: null,
      rank: "C",
      rankSource: null,
      feeYen: null,
      note: "お届け先が未確定のため金額を確定できません。",
      missingCustomerInfo: ["お届け先の都道府県"],
    },
    externalFacts: [],
    unresolved: [{ field: "送料(お届け先未確定)", reason: "都道府県が分からず金額を確定できない" }],
    customerMessage: "埼玉県川口市まで送料はいくらになりますか？",
    history: [],
  });

  // (a) 送料の質問に触れる指示・事実が入っている。
  assertTrue(user.includes("[送料(BELLOの配送料金データベース / 正本)]"), "送料: TRUSTED_FACTSに送料ブロックが入る");
  assertTrue(user.includes("送料: 未確定(金額を案内してはならない)"), "送料: 金額未確定であることが明示される");
  assertTrue(user.includes("埼玉県川口市まで送料はいくらになりますか"), "送料: 顧客の質問文がCUSTOMER_MESSAGEに入る");
  assertTrue(user.includes("UNRESOLVED:\n- 送料(お届け先未確定)"), "送料: UNRESOLVEDに送料の未確定理由が入る");

  // (b) 断定禁止ガードが機能する形。
  assertTrue(system.includes("TRUSTED_FACTS に無い送料の金額"), "送料: 金額を書いてはいけない、という禁止事項がある");
  assertTrue(system.includes("推測で数値・仕様・可否を断定しない"), "送料: 数値の推測断定を禁じる一般ガードがある");
  // 実際に金額を渡していないので、生成前の時点でプロンプト中に円建ての金額が
  // 一切現れないこと(=金額を捏造する材料自体が無いこと)を確認する。
  assertTrue(!/[0-9０-９][0-9０-９,，]*\s*円/.test(user), "送料: 金額(◯円)が一切プロンプトに現れない(捏造の材料が無い)");
}

// ── シナリオ2: 架空の状態質問(傷・汚れの具体的な確認) ───────────────
//
// TRUSTED_FACTSに実際の状態開示(軽微な擦れ傷)がある場合。プロンプトは
// その事実をそのまま渡し、それ以上の(未確認の清掃・研磨等の)創作を
// 禁じるガードを保ったまま届いていることを確認する。
function testConditionInquiryScenario() {
  const system = buildInquirySystemPrompt();
  const user = buildInquiryUserPrompt({
    intents: ["PRODUCT_CONDITION"],
    trustedProductFacts: [
      { label: "コンディション", value: "座面に光に当てると分かる程度の薄い擦れ傷があります。目立った汚れはありません。" },
    ],
    knowledgeExcerpts: [],
    shipping: null,
    externalFacts: [],
    unresolved: [],
    customerMessage: "傷や汚れはどれくらいありますか？写真より状態が心配です。",
    history: [],
  });

  // (a) 状態の質問に触れる事実(実際にTRUSTED_FACTSに書かれている内容)が入る。
  assertTrue(user.includes("座面に光に当てると分かる程度の薄い擦れ傷があります"), "状態: 開示済みの状態説明がTRUSTED_FACTSに入る");
  assertTrue(user.includes("傷や汚れはどれくらいありますか"), "状態: 顧客の状態に関する質問文が入る");

  // (b) 断定禁止・創作禁止ガードが機能する形。
  assertTrue(system.includes("TRUSTED_FACTS に無いことは書かない"), "状態: 事実に無いことを書かない、という一般ガードがある");
  assertTrue(system.includes("誇張しない"), "状態: 誇張しない、というガードがある");
  assertTrue(system.includes("断定できないことを断定しない"), "状態: 断定できないことを断定しない、というガードがある");
  // 開示済みの事実に無い「清掃済み」「研磨済み」等をこちらから足していない
  // ことを、fixture側で確認する(=このテストが渡した事実にそれらが無い)。
  assertTrue(!user.includes("清掃"), "状態: fixtureに無い『清掃』を勝手に混ぜていない");
  assertTrue(!user.includes("研磨"), "状態: fixtureに無い『研磨』を勝手に混ぜていない");
}

// ── シナリオ3: 架空の納期問い合わせ(お届け予定日が未確定) ────────────
function testDeliveryDateInquiryScenario() {
  const system = buildInquirySystemPrompt();
  const user = buildInquiryUserPrompt({
    intents: ["DELIVERY"],
    trustedProductFacts: [],
    knowledgeExcerpts: [],
    shipping: null,
    externalFacts: [],
    unresolved: [{ field: "お届け予定日", reason: "配送日程は個別調整のため確定していない" }],
    customerMessage: "できるだけ早く欲しいのですが、いつ頃届きますか？",
    history: [],
  });

  // (a) 納期の質問に触れる指示・事実が入っている。
  assertTrue(user.includes("UNRESOLVED:\n- お届け予定日"), "納期: UNRESOLVEDにお届け予定日が入る");
  assertTrue(user.includes("いつ頃届きますか"), "納期: 顧客の納期質問文が入る");

  // (b) 断定禁止ガードが機能する形。UNRESOLVEDの項目は「確認が必要」と
  // 自然な日本語で伝える指示があり、同じ言い回しの繰り返しも禁じている。
  assertTrue(system.includes("UNRESOLVED に挙がっている項目は、確認が必要である旨を自然な日本語で伝える"), "納期: UNRESOLVED項目の扱い方が指示されている");
  assertTrue(system.includes("分からないことは分からないと書く"), "納期: 分からないことを断定しない一般ガードがある");
  // 具体的な日付・日数を一切渡していないので、生成前のプロンプトに
  // 「◯日」「◯月◯日」等の具体的な納期表現が現れないことを確認する。
  assertTrue(!/[0-9０-９]+\s*(?:日|営業日)/.test(user), "納期: 日数・日付の具体的な数値が一切プロンプトに現れない(捏造の材料が無い)");
}

// ── シナリオ4: 架空の複数質問(型番の食い違い・重量・追加写真・送料)────
//
// 2026-09-10 追加指示への対応。1通に複数質問が来る実際のパターンを模した
// 架空fixture(原文・識別情報は含まない)。
//
//   「型番はXYZ999と書かれていますが、届いた実物のラベルはABC123でした。
//    重量はどれくらいですか？ あと、追加で写真をいただけますか？
//    送料も知りたいです。」
//
// 改善前は、システムプロンプトに型番食い違い・重量の一般論断定・追加写真の
// 断定を禁じる指示が無かった(このコミットのprompt.ts差分で追加した)。
// このテストは「複数質問に個別に答える指示」と「新設した4つの断定禁止」が
// 同時に効く形でプロンプトへ入ることを確認する。
function testMultiQuestionWithModelMismatchScenario() {
  const system = buildInquirySystemPrompt();
  const user = buildInquiryUserPrompt({
    intents: ["PRODUCT_SPEC", "SHIPPING"],
    trustedProductFacts: [{ label: "型番(BASE商品ページ記載)", value: "XYZ999" }],
    knowledgeExcerpts: [],
    shipping: {
      destinationPrefecture: null,
      rank: "C",
      rankSource: null,
      feeYen: null,
      note: "お届け先が未確定のため金額を確定できません。",
      missingCustomerInfo: ["お届け先の都道府県"],
    },
    externalFacts: [],
    unresolved: [
      {
        field: "型番",
        reason: "お客様が挙げた型番(ABC123)が、把握している型番(XYZ999)と一致しません。社内で現物を確認してください。",
      },
      { field: "重量", reason: "在庫DB・商品説明のどちらにも記載がありません。" },
      { field: "追加の写真", reason: "追加写真の可否は在庫DB・商品説明に記載がありません。" },
      { field: "送料(お届け先未確定)", reason: "都道府県が分からず金額を確定できない" },
    ],
    customerMessage:
      "型番はXYZ999と書かれていますが、届いた実物のラベルはABC123でした。重量はどれくらいですか？あと追加で写真をいただけますか？送料も知りたいです。",
    history: [],
  });

  // (a) 複数質問のそれぞれに触れる事実・UNRESOLVEDが入っている。
  assertTrue(user.includes("UNRESOLVED:\n- 型番"), "複数質問: UNRESOLVEDに型番の食い違いが入る");
  assertTrue(user.includes("- 重量"), "複数質問: UNRESOLVEDに重量が入る");
  assertTrue(user.includes("- 追加の写真"), "複数質問: UNRESOLVEDに追加の写真が入る");
  assertTrue(user.includes("- 送料(お届け先未確定)"), "複数質問: UNRESOLVEDに送料が入る");
  assertTrue(
    system.includes("お客様の質問が複数ある場合は、それぞれに漏れなく具体的に答える"),
    "複数質問: 複数質問へ個別対応する既存ガードがある",
  );

  // (b) 2026-09-10 に新設した4つの断定禁止ガードが実際に入っている。
  assertTrue(
    system.includes("食い違う場合、一致する・間違いないと書かない") && system.includes("社内で現物を確認する旨"),
    "複数質問: 型番食い違いを架空の確認で埋めさせないガードがある",
  );
  assertTrue(
    system.includes("性別や体格についての一般論") && system.includes("安全性を断定しない"),
    "複数質問: 重量不明を性別・一般論で断定させないガードがある",
  );
  assertTrue(
    system.includes("写真の送付可否・写真番号・枚数・清掃状況"),
    "複数質問: 追加写真の可否・枚数・清掃状況を断定させないガードがある",
  );
  assertTrue(
    system.includes("過去の個別対応") && system.includes("今回の商品にも同じように適用できると仮定しない"),
    "複数質問: 過去の個別対応を全商品方針へ転用させないガードがある",
  );
  // 重量の値・型番の正誤いずれも確定値を渡していないので、プロンプトに
  // 具体的な重量(kg/g)が現れないことを確認する(捏造の材料が無い)。
  assertTrue(!/\d+(?:\.\d+)?\s*(?:kg|g)\b/i.test(user), "複数質問: 重量の具体的な数値が一切プロンプトに現れない");
}

function main() {
  testShippingInquiryScenario();
  testConditionInquiryScenario();
  testDeliveryDateInquiryScenario();
  testMultiQuestionWithModelMismatchScenario();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
