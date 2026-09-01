/**
 * §40 生成後の事実検証。純粋関数のみ。
 *
 * 【既存実装を再利用する】lib/ai/productIntro/factSafety.tsのcheckFactSafety
 * が、社内スコア・在庫数・SKU・他人の氏名/住所・捏造ブランド・
 * プロンプト漏洩の検査を既に持っている。返信文も「顧客が読む文章」で
 * あることは出品コピーと同じなので、同じ検査を通す。
 *
 * このファイルが足すのは、**返信案に固有の**検査だけ:
 *   - 送料の金額を、根拠が無いのに書いていないか(§40「送料創作」)
 *   - 不明としたはずの項目を断定していないか(§40「不明事項断言」)
 *   - 外部ページの文章を長くそのまま写していないか(§9.4)
 *   - 在庫DBに無い寸法を創作していないか(§40「ソースにない寸法創作」)
 */
import { checkFactSafety, type FactSafetyViolation } from "@/lib/ai/productIntro/factSafety";
import type { CustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { findLongVerbatimCopy } from "./research/sanitize";
import type { UnresolvedFact } from "./types";

export type ReplyValidationCode =
  | "FABRICATED_SHIPPING_FEE"
  | "ASSERTED_UNRESOLVED_FACT"
  | "EXTERNAL_VERBATIM_COPY"
  | "FABRICATED_DIMENSION"
  | "FACT_SAFETY";

export interface ReplyValidationViolation {
  code: ReplyValidationCode;
  /** 管理者向けの説明。顧客には出さない。 */
  detail: string;
}

export interface ReplyValidationResult {
  ok: boolean;
  violations: ReplyValidationViolation[];
}

/** 「12,000円」「12000 円」「¥12,000」を金額とみなす。 */
const MONEY_PATTERN = /(?:¥|￥)?\s?\d{1,3}(?:,\d{3})+\s?円?|\d{3,7}\s?円/g;

/** 寸法らしき記述。「幅120cm」「120×80cm」等。 */
const DIMENSION_PATTERN = /\d{2,4}(?:\.\d+)?\s*(?:cm|センチ|ｃｍ|mm|ミリ)/gi;

export function validateReplyDraft(params: {
  output: string;
  /** 顧客向けに認めた商品の事実。 */
  facts: CustomerSafeFacts;
  stockQuantity?: number | null;
  sku?: string | null;
  /** 送料の金額を書いてよい場合のみ、その金額(円)。書いてはいけない場合はnull。 */
  allowedShippingFeeYen: number | null;
  /** 分からないままにした項目。 */
  unresolved: UnresolvedFact[];
  /** 外部から取得した本文(sanitize済み)。長文の引き写し検査に使う。 */
  externalTexts: string[];
  /** 生成文に出てよい寸法の文字列(在庫DBの寸法・外部調査で確認できた寸法)。 */
  allowedDimensionText: string[];
  maxLength?: number;
}): ReplyValidationResult {
  const violations: ReplyValidationViolation[] = [];
  const output = params.output ?? "";

  // ── 送料の創作 ────────────────────────────────────────────────
  const moneyMentions = output.match(MONEY_PATTERN) ?? [];
  const allowed = params.allowedShippingFeeYen;
  const allowedForms =
    allowed == null ? [] : [allowed.toLocaleString("ja-JP"), String(allowed)].flatMap((n) => [n, `${n}円`, `¥${n}`, `￥${n}`]);
  const unauthorizedMoney = moneyMentions.filter((mention) => {
    const normalized = mention.replace(/[¥￥\s]/g, "");
    return !allowedForms.some((form) => normalized === form.replace(/[¥￥\s]/g, ""));
  });
  for (const mention of unauthorizedMoney) {
    violations.push({ code: "FABRICATED_SHIPPING_FEE", detail: `根拠のない金額が含まれています: ${mention.trim()}` });
  }

  const factSafety = checkFactSafety({
    output,
    facts: params.facts,
    stockQuantity: params.stockQuantity,
    sku: params.sku,
    maxLength: params.maxLength ?? 1200,
  });
  for (const v of factSafety.violations) {
    // 出品コピーでは金額に触れること自体が違反だが(価格は別項目で管理
    // されるものなので、説明文に混ざると実際の販売価格と食い違う)、
    // 問い合わせ返信では話が違う。「送料はいくらですか」に答えるのが
    // 目的で、その金額は配送データベースから引いた確定値だからだ。
    // 根拠のある金額しか書かれていないことは、すぐ上で既に確かめている
    // —— そのうえでPRICE_CLAIMを立てると、正しい回答が永久に通らない。
    if (v.code === "PRICE_CLAIM" && allowed != null && unauthorizedMoney.length === 0) continue;
    violations.push({ code: "FACT_SAFETY", detail: describeFactSafety(v) });
  }

  // ── 不明としたはずの項目の断定 ──────────────────────────────
  for (const fact of params.unresolved) {
    if (assertsUnresolvedField(output, fact.field)) {
      violations.push({
        code: "ASSERTED_UNRESOLVED_FACT",
        detail: `確認できていない「${fact.field}」について断定的に述べています。`,
      });
    }
  }

  // ── 外部文章の長文コピー ────────────────────────────────────
  for (const text of params.externalTexts) {
    const copied = findLongVerbatimCopy(output, text);
    if (copied) {
      violations.push({
        code: "EXTERNAL_VERBATIM_COPY",
        detail: `外部ページの文章を長くそのまま引き写しています(${copied.slice(0, 30)}…)。`,
      });
      break;
    }
  }

  // ── 寸法の創作 ────────────────────────────────────────────────
  const dimensionMentions = output.match(DIMENSION_PATTERN) ?? [];
  if (dimensionMentions.length > 0) {
    const allowedNumbers = new Set(
      params.allowedDimensionText.flatMap((t) => (t.match(/\d{1,4}(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)))),
    );
    for (const mention of dimensionMentions) {
      const num = mention.match(/\d{1,4}(?:\.\d+)?/)?.[0];
      if (num && !allowedNumbers.has(String(Number(num)))) {
        violations.push({
          code: "FABRICATED_DIMENSION",
          detail: `根拠のない寸法が含まれています: ${mention.trim()}`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 「不明」としたはずの項目について断定しているか。
 *
 * 項目名の近くに肯定・否定の断定表現があるかを見る。文脈を完全に読む
 * ことはできないので、「確認」「お調べ」等のヘッジ表現が同じ文にあれば
 * 断定とはみなさない —— 「耐荷重については確認が必要です」を誤検出しない
 * ためで、ここは見逃す側へ倒す(顧客向けの害は、断定より誤って弾く方が
 * 小さいという判断は取らない。生成し直しのコストが実務上重いため)。
 */
const ASSERTION_MARKERS = ["です", "ます", "できます", "可能です", "対応しています", "ございます"];
const HEDGE_MARKERS = ["確認", "お調べ", "断定", "分かりかね", "わかりかね", "いたしかね", "承っておりません", "不明"];

export function assertsUnresolvedField(output: string, field: string): boolean {
  if (!field || field.length < 2) return false;
  for (const sentence of output.split(/[。\n]/)) {
    if (!sentence.includes(field)) continue;
    if (HEDGE_MARKERS.some((h) => sentence.includes(h))) continue;
    if (ASSERTION_MARKERS.some((a) => sentence.includes(a))) return true;
  }
  return false;
}

function describeFactSafety(v: FactSafetyViolation): string {
  return `${v.code}: ${v.detail}`;
}

/** §40 bounded regeneration。無限に作り直さない。 */
export const REPLY_MAX_GENERATION_ATTEMPTS = 2;
