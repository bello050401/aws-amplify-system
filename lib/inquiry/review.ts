import type { ReplyEvidence } from "./types";
import { detectUnverifiedFulfillment } from "./fulfillmentSafety";
import { detectInternalLeak, detectUngroundedPromises } from "./answerPlan";
import { redactInquiryContacts } from "@/lib/messaging/contactPrivacy";
export const REVIEW_REASONS = [
  "金額計算",
  "商品誤認",
  "根拠不足",
  "ルール違反",
  "聞き直し",
  "回答漏れ",
  "文章表現",
  "情報の古さ",
  "その他",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export interface DraftReview {
  version: "2026-11-08.1";
  at: string;
  status: "REVIEWABLE" | "NEEDS_CUSTOMER" | "NEEDS_STAFF";
  issues: { code: string; message: string }[];
  elapsedMs?: number;
  generationAttempts?: number;
  feedback?: {
    disposition: "EDITED" | "ACCEPTED" | "REJECTED";
    reason: ReviewReason;
    at: string;
    approvedForReuse: false;
  };
}
export function moneyMentions(text: string): number[] {
  const normalized = text.normalize("NFKC");
  return [
    ...normalized.matchAll(
      /(?:[¥￥]\s*(\d[\d,]*(?:\.\d+)?)(万)?|(\d[\d,]*(?:\.\d+)?)(万)?\s*円)/g,
    ),
  ].map(
    (m) =>
      Number((m[1] ?? m[3]).replaceAll(",", "")) * ((m[2] ?? m[4]) ? 10000 : 1),
  );
}
/** Reused for generated and edited drafts. A flag is review work, not proof of correctness. */
export function reviewCustomerDraft(
  text: string,
  e: ReplyEvidence,
  priorStaffTexts: string[] = [],
  now = new Date().toISOString(),
): DraftReview {
  const issues: DraftReview["issues"] = [];
  const add = (code: string, message: string) => {
    if (!issues.some((x) => x.code === code)) issues.push({ code, message });
  };
  const q = e.quote;
  const allowed = new Set<number>(
    q?.confirmed
      ? [
          q.merchandiseYen,
          q.customerShippingYen,
          q.regionalYen,
          q.optionsYen,
          q.discountYen,
          q.totalYen,
        ].filter((n): n is number => n !== null)
      : [],
  );
  for (const p of e.baseProducts ?? [])
    if (p.price !== null) allowed.add(p.price);
  if (e.staffCard?.baseListedPriceYen != null)
    allowed.add(e.staffCard.baseListedPriceYen);
  if (!q && e.shipping?.feeYen != null)
    add(
      "LEGACY_SHIPPING",
      "旧形式の送料根拠です。最新情報で作り直してください。",
    );
  for (const amount of moneyMentions(text))
    if (!allowed.has(amount))
      add(
        "MONEY_UNGROUNDED",
        "計算結果・現在の掲載価格にない金額があります。根拠を確認してください。",
      );
  if (
    q &&
    !q.confirmed &&
    /(?:送料|総額|合計)[^。\n]{0,25}(?:[\d,]+円|無料|かかりません)/.test(text)
  )
    add(
      "UNCONFIRMED_QUOTE",
      "送料の条件が未確定のまま、金額を案内しています。",
    );
  if (q?.confirmed) {
    for (const [label, expected] of [
      ["送料(?!込|を含)", q.customerShippingYen],
      ["(?:支払総額|お支払総額|総額|合計)", q.totalYen],
    ] as const) {
      for (const m of text.matchAll(
        new RegExp(`${label}[^。\\n\\d]{0,16}([\\d,]+)\\s*円`, "g"),
      ))
        if (Number(m[1].replaceAll(",", "")) !== expected)
          add(
            "MONEY_ROLE_MISMATCH",
            "送料・総額の金額が計算内訳と一致しません。",
          );
    }
  }
  if (detectUnverifiedFulfillment(text).length)
    add(
      "DELIVERY_PROMISE",
      "出荷・到着・手配の確約は、配送会社または担当者の確認が必要です。",
    );
  if (detectInternalLeak(text).length)
    add("INTERNAL_LEAK", "社内情報が返信案に含まれています。");
  if (
    detectUngroundedPromises(text, {
      groundedDiscount: !!q?.confirmed && !!q.discountYen,
      groundedCondition: (e.customerFacts ?? []).some(
        (f) => /^状態/.test(f.label) && text.includes(f.value),
      ),
    }).length
  )
    add(
      "UNAPPROVED_PROMISE",
      "値引き・状態等の断定について根拠の確認が必要です。",
    );
  if (
    /(?:返金|無償修理|無料修理)[^。\n]{0,12}(?:します|いたします|承ります|可能です)/.test(
      text,
    )
  )
    add("REFUND_PROMISE", "返金・無償修理の個別承認を確認してください。");
  if (e.productStatus === "AMBIGUOUS")
    add("PRODUCT_AMBIGUOUS", "対象となる在庫個体を確定してください。");
  if (
    e.quote?.conditions.destination &&
    /お届け先(?:の)?(?:都道府県|ご住所|住所)[^。\n]{0,18}(?:教え|知らせ)/.test(
      text,
    )
  )
    add("ASK_KNOWN_DESTINATION", "判明している配送先を聞き直しています。");
  if (redactInquiryContacts(text) !== text)
    add("CONTACT_DATA", "返信案に保存対象外の連絡先・住所が含まれています。");
  if (
    q?.confirmed &&
    priorStaffTexts.some((t) =>
      [...t.matchAll(/(?:総額|合計|お支払)[^。\n\d]{0,16}([\d,]+)\s*円/g)].some(
        (m) => Number(m[1].replaceAll(",", "")) !== q.totalYen,
      ),
    )
  )
    add(
      "PRIOR_QUOTE_CONFLICT",
      "過去の案内金額と今回の計算結果が異なる可能性があります。元の会話で確認してください。",
    );
  const missing = e.unresolvedFacts ?? [];
  return {
    version: "2026-11-08.1",
    at: now,
    status:
      issues.length || missing.some((x) => !/お届け先|配送地域/.test(x.field))
        ? "NEEDS_STAFF"
        : missing.length
          ? "NEEDS_CUSTOMER"
          : "REVIEWABLE",
    issues,
  };
}
