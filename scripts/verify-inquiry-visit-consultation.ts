import { extractIntents, hasProductIndependentIntent } from "@/lib/inquiry/intent";
import {
  detectHumanHandoff,
  emptyHumanHandoffState,
  encodeHandoffReviewReasons,
  mergeHumanHandoff,
  parseHandoffFromReviewReasons,
} from "@/lib/inquiry/humanHandoff";
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

// ── 今回・直近履歴からの検出 ─────────────────────────────────────
const currentSignal = detectHumanHandoff({
  currentText: "リビング・ダイニングの家具や照明を一緒に選んでほしいです。間取りもあります。",
  history: [],
});
assert(currentSignal.required && currentSignal.fromCurrentMessage, "今回の空間全体相談を信号として検出する");

const currentEvidence = mergeHumanHandoff({
  prior: emptyHumanHandoffState(),
  current: currentSignal,
  now: "2026-09-17T00:00:00.000Z",
});
assert(currentEvidence.required && !currentEvidence.carriedOverFromHistory, "今回の相談は履歴からの継続ではないと判定する");
assert(currentEvidence.status === "PENDING_STAFF_REVIEW", "引き継ぎが必要な状態を明示する");
assert(currentEvidence.nextAction != null && currentEvidence.nextAction.length > 0, "次のアクションを持つ");
assert(currentEvidence.decidedAt === "2026-09-17T00:00:00.000Z", "判定時刻を記録する");

const historySignal = detectHumanHandoff({
  currentText: "配送はいつ頃になりますか？",
  history: [
    { direction: "INBOUND", body: "リビングとダイニングの家具や照明を相談したいです" },
    { direction: "OUTBOUND", body: "担当者がご希望を伺います" },
  ],
});
const historyEvidence = mergeHumanHandoff({
  prior: emptyHumanHandoffState(),
  current: historySignal,
  now: "2026-09-17T00:00:00.000Z",
});
assert(historyEvidence.required && historyEvidence.carriedOverFromHistory, "後続の配送質問でも人間対応を渡された履歴から保持する");

// ── 会話文脈への永続化: historyのwindowから元メッセージが外れても消えない ──
//
// 1通目で相談を検出 → ConversationContext.reviewReasonsへ符号化 → 2通目では
// history にその1通目がもう含まれない(window外)状態を再現する。
const encoded = encodeHandoffReviewReasons(currentEvidence);
assert(encoded.length > 0, "確定した引き継ぎ状態を符号化する");

const laterTurnSignal = detectHumanHandoff({
  currentText: "配送はいつ頃になりますか？",
  // 相談を依頼した1通目はもう history に無い(windowから外れた想定)。
  history: [{ direction: "OUTBOUND", body: "担当者がご希望を伺います" }],
});
assert(!laterTurnSignal.required, "元メッセージがhistoryから外れると単独の信号検出では拾えない(前提の確認)");

const priorFromContext = parseHandoffFromReviewReasons(encoded);
assert(priorFromContext.required, "reviewReasonsへ符号化した引き継ぎ状態を復元できる");
assert(priorFromContext.decidedAt === "2026-09-17T00:00:00.000Z", "復元した状態も判定時刻を保持する");

const laterTurnEvidence = mergeHumanHandoff({
  prior: priorFromContext,
  current: laterTurnSignal,
  now: "2026-09-18T00:00:00.000Z",
});
assert(laterTurnEvidence.required, "元メッセージがhistoryから外れても会話文脈からの永続化で引き継ぎを保持する");
assert(laterTurnEvidence.carriedOverFromHistory, "今回は履歴からの継続として扱う");
assert(laterTurnEvidence.decidedAt === "2026-09-17T00:00:00.000Z", "最初に判定した時刻を上書きしない");

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
  humanHandoff: laterTurnEvidence,
};
const review = decideReview({ draftStatus: "READY", evidence, deliveryWindowState: null, generationFailed: false });
assert(review.needsHumanReview, "家具・照明選びは返信案がREADYでも担当者確認を要求する");
assert(review.reasons.some((reason) => reason.includes("過去の会話")), "履歴から継続した理由を担当者へ示す");
assert(review.reasons.some((reason) => reason.includes("判定時刻")), "内部通知に判定時刻を含める");
assert(review.reasons.some((reason) => reason.includes("状態：担当者確認待ち")), "内部通知に現在の状態を含める");
assert(review.reasons.some((reason) => reason.includes("次のアクション")), "内部通知に次のアクションを含める");
assert(review.reasons.some((reason) => reason.includes("根拠")), "内部通知に判定根拠を含める");

assert(BUSINESS_RULE_SEEDS.some((seed) => seed.title === VISIT_CONSULTATION_RULES_TITLE), "見学ルールを初期ナレッジへ登録する");
for (const phrase of ["通常の店舗ではなく", "大型家具は1点", "平日9時から17時", "9時から16時", "購入後約2週間", "1か月を超える"]) {
  assert(VISIT_CONSULTATION_RULES_CONTENT.includes(phrase), `業務ルールに「${phrase}」を保持する`);
}

console.log(`\n${passes} passed, 0 failed`);
