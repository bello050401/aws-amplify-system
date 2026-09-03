/**
 * 2026-09-03 指示書 §16/§19/§22: 返信ルールの絞り込み。
 *
 * ── 全部渡さない ────────────────────────────────────────────────
 *
 * §22「全DBを毎回丸ごと渡さない」。ルールが増えるほど、関係のない指示が
 * プロンプトに混ざって**本来効くべきルールが薄まる**。値下げ交渉の返信を
 * 作るときに領収書ルールと修理ルールを渡しても、判断が良くなることはない。
 *
 * ── 純粋関数にする理由 ──────────────────────────────────────────
 *
 * 「どのルールが効いたか」はAI処理ログに出す監査項目(§24)。ここが
 * ぶれると、後から「なぜこの返信になったのか」を追えなくなる。
 * DBにもAIにも触らない形にして、選び方を verify で固定する。
 */
import type { InquiryIntent } from "./types";
import type { MessageChannel } from "@/lib/messaging/types";

export type ReplyRuleCategory =
  | "DISCOUNT"
  | "SHIPPING"
  | "DELIVERY_DATE"
  | "PRODUCT_CONDITION"
  | "RESERVATION"
  | "STOCK"
  | "RETURN"
  | "CANCELLATION"
  | "RECEIPT"
  | "PAYMENT"
  | "SIZE"
  | "REPAIR"
  | "OTHER";

export const REPLY_RULE_CATEGORY_LABEL: Record<ReplyRuleCategory, string> = {
  DISCOUNT: "値下げ交渉",
  SHIPPING: "送料",
  DELIVERY_DATE: "配送・到着日",
  PRODUCT_CONDITION: "商品の状態",
  RESERVATION: "取り置き",
  STOCK: "在庫",
  RETURN: "返品",
  CANCELLATION: "キャンセル",
  RECEIPT: "領収書",
  PAYMENT: "支払い",
  SIZE: "サイズ",
  REPAIR: "修理・メンテナンス",
  OTHER: "その他",
};

export const REPLY_RULE_CATEGORIES = Object.keys(REPLY_RULE_CATEGORY_LABEL) as ReplyRuleCategory[];

export interface ReplyRuleRecord {
  id: string;
  title: string;
  category: ReplyRuleCategory;
  description: string | null;
  conditions: string | null;
  instruction: string;
  priority: number;
  enabled: boolean;
  /** 空配列は「全チャネル」。 */
  channelScope: MessageChannel[];
  /** 空配列は「全カテゴリー」。 */
  productCategoryScope: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 問い合わせ種別 → 返信ルールの分類。
 *
 * 1つの種別が複数の分類に対応することがある(返品・キャンセルの問い合わせは
 * どちらのルールも見たい)ので配列で持つ。
 */
const INTENT_TO_CATEGORIES: Record<InquiryIntent, ReplyRuleCategory[]> = {
  NEGOTIATION: ["DISCOUNT"],
  PRICE: ["DISCOUNT", "PAYMENT"],
  SHIPPING: ["SHIPPING"],
  DELIVERY: ["DELIVERY_DATE", "SHIPPING"],
  PRODUCT_CONDITION: ["PRODUCT_CONDITION"],
  PRODUCT_SPEC: ["PRODUCT_CONDITION"],
  MATERIAL: ["PRODUCT_CONDITION"],
  COMPATIBILITY: ["SIZE"],
  SIZE: ["SIZE"],
  STOCK: ["STOCK", "RESERVATION"],
  RETURN_POLICY: ["RETURN", "CANCELLATION"],
  VISIT: ["RESERVATION"],
  STORE_INFO: ["OTHER"],
  BUSINESS_HOURS: ["OTHER"],
  OTHER: ["OTHER"],
};

/**
 * この件で参照するルールの上限。
 *
 * プロンプトが長くなるほど、個々の指示への追従は弱くなる。10件を超えて
 * 効かせたいルールがあるなら、それは優先度の設定がされていないという
 * ことなので、件数で殴らずに priority で並べ替えるべき。
 */
export const MAX_RULES_PER_REPLY = 10;

export interface SelectRulesInput {
  rules: ReplyRuleRecord[];
  intents: InquiryIntent[];
  channel: MessageChannel;
  /** 特定できた商品のカテゴリーID。特定できていなければ null。 */
  productCategoryId: string | null;
  /**
   * 配送先の都道府県が既に分かっているか(2026-09-03 実測の不具合)。
   *
   * ルール「配送先が不明な値下げ交渉」は、配送先が判明している場面でも
   * 選ばれていた。ルールは種別(DISCOUNT)とチャネルでしか絞っておらず、
   * 会話の状態を知らないため。結果、
   *
   *   顧客: 埼玉県でこちら2脚で6万円になりませんか
   *   返信案: まずは配送先の都道府県を教えていただけますでしょうか
   *
   * という、お客様が書いたことを読んでいない返信になっていた。
   * 省略時は false(=不明)。既存の呼び出しの挙動は変わらない。
   */
  destinationKnown?: boolean;
}

function matchesChannel(rule: ReplyRuleRecord, channel: MessageChannel): boolean {
  // 空 = 全チャネル。「指定が無い」を「どこにも適用しない」と読むと、
  // 作ったルールが黙って無視される。
  if (rule.channelScope.length === 0) return true;
  return rule.channelScope.includes(channel);
}

/**
 * 「配送先が分からないとき用」のルールか。
 *
 * ルールの適用条件は自由記述なので、機械的に評価できるのはこの一点だけ。
 * **判定できるものだけを判定し、それ以外は従来どおり通す** —— 条件文を
 * 無理に解釈して落とすと、書いたルールが黙って効かなくなる。
 */
function isDestinationUnknownRule(rule: ReplyRuleRecord): boolean {
  const text = `${rule.title} ${rule.conditions ?? ""}`;
  return /(?:配送先|お届け先|発送先)[^。\n]{0,6}(?:が)?[^。\n]{0,4}(?:不明|未確定|分からな|わからな)/.test(text);
}

function matchesCategory(rule: ReplyRuleRecord, productCategoryId: string | null): boolean {
  if (rule.productCategoryScope.length === 0) return true;
  // 商品カテゴリーで絞られたルールは、**商品が特定できていないときは
  // 適用しない**。どのカテゴリーか分からないのに適用すると、無関係な
  // 商品のルールで返信を作ることになる。
  if (!productCategoryId) return false;
  return rule.productCategoryScope.includes(productCategoryId);
}

/**
 * 問い合わせに関係するルールだけを、優先度順に返す。
 *
 * 並びは priority 昇順 → title 昇順。同点を title で決めるのは、
 * 実行のたびに順序が変わると「同じ問い合わせなのに返信が変わる」
 * ことになり、監査もテストもできなくなるため。
 */
export function selectReplyRules(input: SelectRulesInput): ReplyRuleRecord[] {
  const wanted = new Set<ReplyRuleCategory>();
  for (const intent of input.intents) {
    for (const c of INTENT_TO_CATEGORIES[intent] ?? []) wanted.add(c);
  }
  // 種別が1つも取れなかったときは OTHER だけを見る。何も渡さないと
  // 「どんな問い合わせにも共通の方針」まで落ちてしまう。
  if (wanted.size === 0) wanted.add("OTHER");

  return input.rules
    .filter((r) => r.enabled)
    .filter((r) => wanted.has(r.category))
    .filter((r) => matchesChannel(r, input.channel))
    .filter((r) => matchesCategory(r, input.productCategoryId))
    // 配送先が分かっているなら、「配送先が不明なとき用」のルールは渡さない。
    // 渡すと、既に聞いたことをもう一度尋ねる返信になる。
    .filter((r) => !(input.destinationKnown === true && isDestinationUnknownRule(r)))
    .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, "ja"))
    .slice(0, MAX_RULES_PER_REPLY);
}

/**
 * 選んだルールをプロンプトへ入れる形にする。
 *
 * **顧客の文面と混ざらない形にする**(§32 prompt injection対策)。
 * ルールは「BELLOが定めた判断基準」で、顧客が書いた文章とは信頼度が
 * 全く違う。呼び出し側がシステム側のブロックへ入れる前提で、ここでは
 * 見出し付きの箇条書きだけを返す。
 */
export function formatRulesForPrompt(rules: ReplyRuleRecord[]): string {
  if (rules.length === 0) return "";
  return rules
    .map((r) => {
      const lines = [`## ${r.title}(${REPLY_RULE_CATEGORY_LABEL[r.category]})`];
      if (r.conditions?.trim()) lines.push(`適用条件: ${r.conditions.trim()}`);
      lines.push(r.instruction.trim());
      return lines.join("\n");
    })
    .join("\n\n");
}
