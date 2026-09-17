import type { AnswerPlan } from "./answerPlan";

type Fact = { label: string; value: string };

/** Use only facts already approved for the customer. All output still goes through the reply validators. */
export function buildFreeReply(plan: AnswerPlan, facts: Fact[], complete = false): string {
  const labels = new Set(plan.items.flatMap((item) => item.status === "CONFLICT" ? [] : item.evidenceRefs));
  const selected = facts.filter((fact) => labels.has(fact.label));
  const lines = ["お問い合わせいただきありがとうございます。"];
  if (selected.length) {
    lines.push("確認できている商品情報は以下のとおりです。", ...selected.map((fact) => `・${fact.label}：${fact.value}`));
  }
  if (!complete || !selected.length) lines.push("ご質問の詳細については、担当者による確認が必要です。");
  return lines.join("\n");
}

/** Narrow eligibility prevents keyword matches from claiming to understand complex requests. */
export function canAnswerWithoutAI(plan: AnswerPlan, facts: Fact[], hasSpecialInstructions: boolean, message: string): boolean {
  if (hasSpecialInstructions || plan.items.length === 0 || plan.items.length > 4) return false;
  // A request to interpret, compare or promise something needs more than a fact listing.
  if (/比較|違い|おすすめ|理由|なぜ|可能|できます|できる|入ります|入る|設置|変更|加工|修理|似合|合います|より|場合|なら/.test(message)) return false;
  return plan.items.every((item) => item.status === "ANSWERABLE"
    && ["SIZE", "MATERIAL", "PRODUCT_CONDITION", "PRODUCT_SPEC"].includes(item.topic)
    && item.evidenceRefs.length > 0
    && item.evidenceRefs.every((label) => facts.some((fact) => fact.label === label && fact.value.trim())));
}
