/**
 * 返信ルールの絞り込みを固定する検証。DBにもAIにも繋がない。
 *
 * ── なぜここを固定するか ────────────────────────────────────────
 *
 * 「どのルールが効いたか」はAI処理ログの監査項目(§24)であり、返信の
 * 内容そのものを決める。ここが緩むと次の2つが起きる:
 *
 *   関係ないルールまで渡す … 指示が薄まり、本来効くべき方針が効かない
 *   関係あるルールを落とす … 作ったルールが黙って無視される
 *
 * どちらも「AIの出力が何となく変」という形でしか表面化せず、原因の特定に
 * 時間がかかる。選び方だけを純粋関数に切り出して固定する。
 *
 * Run with: npm run verify:reply-rules
 */
import {
  formatRulesForPrompt,
  MAX_RULES_PER_REPLY,
  REPLY_RULE_CATEGORIES,
  REPLY_RULE_CATEGORY_LABEL,
  selectReplyRules,
  type ReplyRuleRecord,
} from "@/lib/inquiry/replyRuleSelection";
import type { MessageChannel } from "@/lib/messaging/types";

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

function rule(over: Partial<ReplyRuleRecord> & { title: string }): ReplyRuleRecord {
  return {
    id: `rule-${over.title}`,
    category: "OTHER",
    description: null,
    conditions: null,
    instruction: "指示本文",
    priority: 100,
    enabled: true,
    channelScope: [],
    productCategoryScope: [],
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const titles = (rules: ReplyRuleRecord[]) => rules.map((r) => r.title);

function testIntentMapping() {
  const rules = [
    rule({ title: "値下げ", category: "DISCOUNT" }),
    rule({ title: "送料", category: "SHIPPING" }),
    rule({ title: "配送日", category: "DELIVERY_DATE" }),
    rule({ title: "領収書", category: "RECEIPT" }),
    rule({ title: "共通", category: "OTHER" }),
  ];

  assertEqual(
    titles(selectReplyRules({ rules, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })),
    ["値下げ"],
    "絞り込み: 値下げ交渉には値下げルールだけを渡す",
  );
  assertTrue(
    !titles(selectReplyRules({ rules, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })).includes("領収書"),
    "絞り込み: 関係ないルール(領収書)を渡さない",
  );
  assertEqual(
    titles(selectReplyRules({ rules, intents: ["DELIVERY"], channel: "LINE", productCategoryId: null })).sort(),
    ["配送日", "送料"].sort(),
    "絞り込み: 配送の問い合わせでは配送日と送料の両方を見る",
  );
  assertEqual(
    titles(selectReplyRules({ rules, intents: [], channel: "LINE", productCategoryId: null })),
    ["共通"],
    "絞り込み: 種別が取れなくても共通ルール(OTHER)は渡す",
  );
}

function testEnabledAndScope() {
  const base = [
    rule({ title: "有効", category: "DISCOUNT" }),
    rule({ title: "無効", category: "DISCOUNT", enabled: false }),
  ];
  assertEqual(
    titles(selectReplyRules({ rules: base, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })),
    ["有効"],
    "絞り込み: 無効なルールは渡さない",
  );

  const scoped = [
    rule({ title: "全チャネル", category: "DISCOUNT" }),
    rule({ title: "LINE限定", category: "DISCOUNT", channelScope: ["LINE"] as MessageChannel[] }),
    rule({ title: "BASE限定", category: "DISCOUNT", channelScope: ["BASE"] as MessageChannel[] }),
  ];
  assertEqual(
    titles(selectReplyRules({ rules: scoped, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })).sort(),
    ["LINE限定", "全チャネル"].sort(),
    "絞り込み: チャネル指定なしは全チャネルへ適用する",
  );
  assertTrue(
    !titles(selectReplyRules({ rules: scoped, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })).includes("BASE限定"),
    "絞り込み: 他チャネル限定のルールは渡さない",
  );

  const byCategory = [
    rule({ title: "全カテゴリー", category: "SIZE" }),
    rule({ title: "ソファ限定", category: "SIZE", productCategoryScope: ["cat-sofa"] }),
  ];
  assertEqual(
    titles(selectReplyRules({ rules: byCategory, intents: ["SIZE"], channel: "LINE", productCategoryId: "cat-sofa" })).sort(),
    ["ソファ限定", "全カテゴリー"].sort(),
    "絞り込み: 商品カテゴリーが一致すれば適用する",
  );
  // 商品が特定できていないのにカテゴリー限定ルールを適用しない。
  // 無関係な商品のルールで返信を作ることになる。
  assertEqual(
    titles(selectReplyRules({ rules: byCategory, intents: ["SIZE"], channel: "LINE", productCategoryId: null })),
    ["全カテゴリー"],
    "絞り込み: 商品未特定ならカテゴリー限定ルールは適用しない",
  );
}

function testOrderAndCap() {
  const rules = [
    rule({ title: "後", category: "DISCOUNT", priority: 200 }),
    rule({ title: "先", category: "DISCOUNT", priority: 10 }),
    rule({ title: "中", category: "DISCOUNT", priority: 100 }),
  ];
  assertEqual(
    titles(selectReplyRules({ rules, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })),
    ["先", "中", "後"],
    "並び順: priority の小さいものが先",
  );

  // 同点は title 順で安定させる。実行のたびに順序が変わると
  // 「同じ問い合わせなのに返信が変わる」ことになり監査できない。
  const tied = [
    rule({ title: "い", category: "DISCOUNT", priority: 50 }),
    rule({ title: "あ", category: "DISCOUNT", priority: 50 }),
  ];
  assertEqual(
    titles(selectReplyRules({ rules: tied, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null })),
    ["あ", "い"],
    "並び順: 同じ優先度は名前順で安定する",
  );

  const many = Array.from({ length: MAX_RULES_PER_REPLY + 5 }, (_, i) =>
    rule({ title: `r${String(i).padStart(2, "0")}`, category: "DISCOUNT", priority: i }),
  );
  assertEqual(
    selectReplyRules({ rules: many, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null }).length,
    MAX_RULES_PER_REPLY,
    `件数: 1件の返信につき最大${MAX_RULES_PER_REPLY}件までに抑える(§22 全部渡さない)`,
  );
  assertEqual(
    titles(selectReplyRules({ rules: many, intents: ["NEGOTIATION"], channel: "LINE", productCategoryId: null }))[0],
    "r00",
    "件数: 上限で切るときも優先度の高いものが残る",
  );
}

function testPromptFormat() {
  assertEqual(formatRulesForPrompt([]), "", "プロンプト: ルールが無ければ空文字(空の見出しを出さない)");

  const out = formatRulesForPrompt([
    rule({ title: "配送先確認", category: "DISCOUNT", conditions: "配送先が不明なとき", instruction: "先に都道府県を伺う。" }),
  ]);
  assertTrue(out.includes("配送先確認"), "プロンプト: ルール名を含む");
  assertTrue(out.includes("値下げ交渉"), "プロンプト: 分類は日本語ラベルで出す");
  assertTrue(out.includes("適用条件: 配送先が不明なとき"), "プロンプト: 適用条件を含む");
  assertTrue(out.includes("先に都道府県を伺う。"), "プロンプト: 指示本文を含む");

  const noCond = formatRulesForPrompt([rule({ title: "常時", category: "OTHER", conditions: null })]);
  assertTrue(!noCond.includes("適用条件"), "プロンプト: 条件が無ければ適用条件の行を出さない");
}

function testLabels() {
  // ラベルが欠けると管理画面のセレクトに空の選択肢が出る。
  for (const c of REPLY_RULE_CATEGORIES) {
    assertTrue(Boolean(REPLY_RULE_CATEGORY_LABEL[c]), `ラベル: ${c} に日本語名がある`);
  }
}

testIntentMapping();
testEnabledAndScope();
testOrderAndCap();
testPromptFormat();
testLabels();
testDestinationKnownFilter();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);

/**
 * 配送先が分かっているときに「配送先が不明なとき用」のルールを渡さない。
 *
 * 実機(2026-09-03)で、配送先が判明しているのに
 * 「まずは配送先の都道府県を教えていただけますでしょうか」と返す返信案が
 * 出た。ルールは種別とチャネルでしか絞っておらず、会話の状態を知らない。
 */
function testDestinationKnownFilter() {
  const rules = [
    rule({ title: "配送先が不明な値下げ交渉", category: "DISCOUNT", priority: 1 }),
    rule({ title: "値下げ交渉の基本方針", category: "DISCOUNT", priority: 2 }),
    rule({ title: "お届け先が未確定のときの送料案内", category: "SHIPPING", priority: 3, conditions: null }),
  ];

  const known = selectReplyRules({
    rules,
    intents: ["NEGOTIATION", "SHIPPING"],
    channel: "LINE",
    productCategoryId: null,
    destinationKnown: true,
  }).map((r) => r.title);
  assertTrue(!known.includes("配送先が不明な値下げ交渉"), "ルール選択: 配送先が分かっていれば不明時用ルールを渡さない");
  assertTrue(!known.includes("お届け先が未確定のときの送料案内"), "ルール選択: 表現が違っても不明時用と判定する");
  assertTrue(known.includes("値下げ交渉の基本方針"), "ルール選択: 通常のルールは従来どおり渡す");

  const unknown = selectReplyRules({
    rules,
    intents: ["NEGOTIATION", "SHIPPING"],
    channel: "LINE",
    productCategoryId: null,
    destinationKnown: false,
  }).map((r) => r.title);
  assertTrue(unknown.includes("配送先が不明な値下げ交渉"), "ルール選択: 配送先が不明なら従来どおり渡す");

  // 省略時は既存の挙動(=不明扱い)を変えない。
  const omitted = selectReplyRules({
    rules,
    intents: ["NEGOTIATION"],
    channel: "LINE",
    productCategoryId: null,
  }).map((r) => r.title);
  assertTrue(omitted.includes("配送先が不明な値下げ交渉"), "ルール選択: 未指定なら既存の挙動を変えない");
}
