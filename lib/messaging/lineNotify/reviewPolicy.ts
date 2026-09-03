/**
 * 2026-09-03 指示書 §33/§16-2/§17/§23: 「人間の判断が必要か」の判定。
 *
 * ── なぜ独立した判定にするか ────────────────────────────────────
 *
 * §33 は1通目の先頭へ【要確認】を出すことを求めている。これが正しく
 * 出ないと2種類の事故が起きる:
 *
 *   出るべきときに出ない … 担当者が返信案をそのまま貼って顧客へ送る。
 *                          配送先不明のまま値引き額を約束する等、
 *                          §44「絶対禁止事項」に直接あたる。
 *   出なくてよいのに出る … 毎回【要確認】が付き、印として機能しなくなる。
 *
 * どちらも本番でしか気づけない類の不具合なので、AWSにもLINEにも触らない
 * 純粋関数に切り出し、scripts/verify-line-notify.ts で全分岐を固定する。
 *
 * ── 判定の材料は既存のものだけを使う ────────────────────────────
 *
 * 新しい判断ロジックをここで発明しない。返信案の状態(ReplyDraftStatus)、
 * 値下げ判定(NegotiationEvidence)、配送日判定(DeliveryWindowState)は
 * すでにコードが持っている結論なので、それを読み替えるだけにする。
 * ここで独自判定を足すと、画面の表示とLINEの表示が食い違う。
 */
import type { ReplyDraftStatus, ReplyEvidence } from "@/lib/inquiry/types";
import type { DeliveryWindowState } from "@/lib/inquiry/deliveryWindow";

export interface ReviewDecision {
  needsHumanReview: boolean;
  /** なぜ人が判断する必要があるか。1通目へそのまま出す。 */
  reasons: string[];
}

export interface ReviewInput {
  draftStatus: ReplyDraftStatus | null;
  evidence: ReplyEvidence | null;
  /** 配送希望日の判定結果。判定していなければ null。 */
  deliveryWindowState: DeliveryWindowState | null;
  /** AI生成そのものが失敗したか。 */
  generationFailed: boolean;
}

/**
 * 返信案の状態のうち、人の判断・追加確認なしには送れないもの。
 * READY / USED / DISMISSED 以外はすべて「まだ人が見る必要がある」。
 */
const STATUS_REASON: Partial<Record<ReplyDraftStatus, string>> = {
  NEEDS_PRODUCT_CONFIRMATION: "対象商品を特定できていません。どの商品かを確認してください。",
  NEEDS_CUSTOMER_INFO: "回答に必要な情報がお客様から得られていません。",
  RESEARCH_INCOMPLETE: "確認しきれなかった事実があります。返信前に内容を確かめてください。",
  FAILED: "返信案の生成に失敗しました。",
  GENERATING: "返信案の生成が完了していません。",
};

export function decideReview(input: ReviewInput): ReviewDecision {
  const reasons: string[] = [];

  if (input.generationFailed) {
    reasons.push("返信案の自動生成に失敗しました。内容を確認して手動で返信してください。");
  }

  if (input.draftStatus) {
    const fromStatus = STATUS_REASON[input.draftStatus];
    // 生成失敗の理由を二重に並べない(上で既に書いている)。
    if (fromStatus && !(input.generationFailed && input.draftStatus === "FAILED")) reasons.push(fromStatus);
  }

  const negotiation = input.evidence?.negotiation ?? null;
  if (negotiation?.detected) {
    // §16-2 / §44「配送先不明で値下げ額を勝手に確定」しない。
    // 送料が出せない状態での値下げ可否はコードでも決めていないので、
    // 人が決めるという事実をそのまま通知へ出す。
    if (negotiation.awaitingDestination) {
      reasons.push("値下げ交渉ですが配送先が不明です。送料が確定しないため、値引き額はご判断ください。");
    } else {
      reasons.push("値下げ交渉です。最終的な値引き額はご判断ください。");
    }
  }

  // §17 購入後2週間を超える配送希望日はAIで断定しない。
  if (input.deliveryWindowState === "HUMAN_REVIEW_REQUIRED") {
    reasons.push("配送希望日が購入後2週間を超えています。対応可否はご判断ください。");
  }

  // 商品固有の回答が必要なのに商品が決まっていない場合。§40 Case D の
  // 「誤商品を表示しない」に対応する通知側の表現。
  const status = input.evidence?.productStatus;
  if (status === "AMBIGUOUS") {
    reasons.push("商品の候補が複数あり、1件に絞れていません。");
  }

  return { needsHumanReview: reasons.length > 0, reasons };
}
