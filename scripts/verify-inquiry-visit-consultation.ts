import { extractIntents, hasProductIndependentIntent } from "@/lib/inquiry/intent";
import { detectHumanHandoff } from "@/lib/inquiry/humanHandoff";
import { decideReview } from "@/lib/messaging/lineNotify/reviewPolicy";
import {
  BUSINESS_RULE_SEEDS,
  VISIT_CONSULTATION_RULES_CONTENT,
  VISIT_CONSULTATION_RULES_TITLE,
} from "@/lib/knowledge/businessRules";
import type { ReplyEvidence } from "@/lib/inquiry/types";

let passes = 0;
const assert = (condition: boolean, label: string) => {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passes++;
  console.log(`✓ ${label}`);
};

const intents = extractIntents("見学予約をしたいです。こちらは取り置きできますか");
assert(intents.includes("VISIT"), "見学・予約を来店意図として検出する");
assert(intents.includes("STOCK"), "取り置きを在庫意図として検出する");
assert(hasProductIndependentIntent(intents), "商品未確定でも見学案内を継続できる");

const current = detectHumanHandoff({
  currentText: "リビング・ダイニングの家具や照明を一緒に選んでほしいです。間取りもあります。",
  history: [],
});
assert(current.required && !current.carriedOverFromHistory, "今回の空間全体相談を人間対応へ引き継ぐ");

const carried = detectHumanHandoff({
  currentText: "配送はいつ頃になりますか？",
  history: [
    { direction: "INBOUND", body: "リビングとダイニングの家具や照明を相談したいです" },
    { direction: "OUTBOUND", body: "担当者がご希望を伺います" },
  ],
});
assert(carried.required && carried.carriedOverFromHistory, "後続の配送質問でも人間対応を履歴から保持する");

const evidence: ReplyEvidence = {
  product: null,
  productStatus: "NOT_REFERENCED",
  productCandidates: [],
  inventoryFieldsUsed: [],
  knowledgeDocuments: [],
  shipping: null,
  externalResearchAttempted: false,
  externalFacts: [],
  unresolvedFacts: [],
  humanHandoff: carried,
};
const review = decideReview({ draftStatus: "READY", evidence, deliveryWindowState: null, generationFailed: false });
assert(review.needsHumanReview, "家具・照明選びは返信案がREADYでも担当者確認を要求する");
assert(review.reasons.some((reason) => reason.includes("過去の会話")), "履歴から継続した理由を担当者へ示す");

assert(BUSINESS_RULE_SEEDS.some((seed) => seed.title === VISIT_CONSULTATION_RULES_TITLE), "見学ルールを初期ナレッジへ登録する");
for (const phrase of ["通常の店舗ではなく", "大型家具は1点", "平日9時から17時", "9時から16時", "購入後約2週間", "1か月を超える"]) {
  assert(VISIT_CONSULTATION_RULES_CONTENT.includes(phrase), `業務ルールに「${phrase}」を保持する`);
}

console.log(`\n${passes} passed, 0 failed`);
