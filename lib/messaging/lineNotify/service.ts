import "server-only";
import type { InquiryIntent, ReplyDraftStatus, ReplyEvidence } from "@/lib/inquiry/types";
import type { DeliveryWindowState } from "@/lib/inquiry/deliveryWindow";
import type { MessageChannel } from "@/lib/messaging/types";
import { LineNotifyError, sendNotifyPush } from "./client";
import { buildDedupeKey, canSend, decideAfterFailure, MAX_DELIVERY_ATTEMPTS } from "./deliveryPolicy";
import {
  createPendingDelivery,
  findDeliveryByDedupeKey,
  markDeliveryFailed,
  markDeliveryProcessing,
  markDeliverySent,
  resetDeliveryForRetry,
  updateDeliveryContent,
  type NotificationDeliveryRecord,
} from "./deliveryStore";
import { buildNotificationMessages, type NotificationInput } from "./format";
import { decideReview } from "./reviewPolicy";
import { getLineNotifySettings, recordNotifyResult } from "./settingsStore";

/**
 * 2026-09-03 指示書 §7/§8/§34: 問い合わせ1件を社内LINEへ通知する。
 *
 * ── 問い合わせ処理から切り離す ──────────────────────────────────
 *
 * §8「LINE送信は問い合わせ処理本体と分離し、送信失敗で問い合わせデータ
 * 自体を失わないようにする」。この関数は**例外を投げない**。呼び出し元
 * (Webhook受信・返信案生成)は通知の成否に関係なく自分の処理を完了できる。
 * 失敗は NotificationDelivery に残り、画面から再送できる。
 *
 * ── 生成に失敗しても通知する ────────────────────────────────────
 *
 * §34。返信案が作れなくても、問い合わせが来た事実は必ず届ける。
 * 「AIが失敗したので誰にも知らせない」が一番まずい。
 */

export interface NotifyInquiryParams {
  conversationId: string;
  sourceMessageId: string;
  channel: MessageChannel;
  customerName: string | null;
  messageText: string;
  intents: InquiryIntent[];
  evidence: ReplyEvidence | null;
  draftText: string | null;
  replyDraftId: string | null;
  draftStatus: ReplyDraftStatus | null;
  deliveryWindowState: DeliveryWindowState | null;
  /** 生成が失敗した理由(担当者向けの短い日本語)。成功していれば null。 */
  failureReason: string | null;
  createdBy: string | null;
}

export interface NotifyResult {
  /** 実際にLINEへ送ったか。 */
  sent: boolean;
  /** 送らなかった場合を含めた最終状態。 */
  status: NotificationDeliveryRecord["status"];
  /** なぜこの結果になったか。画面とログにそのまま出す。 */
  reason: string;
  deliveryId: string | null;
}

function toNotificationInput(params: NotifyInquiryParams): NotificationInput {
  const review = decideReview({
    draftStatus: params.draftStatus,
    evidence: params.evidence,
    deliveryWindowState: params.deliveryWindowState,
    generationFailed: params.failureReason !== null,
  });
  return {
    channel: params.channel,
    customerName: params.customerName,
    messageText: params.messageText,
    intents: params.intents,
    evidence: params.evidence,
    draftText: params.draftText,
    needsHumanReview: review.needsHumanReview,
    reviewReasons: review.reasons,
    // §34 管理画面ログIDとして返信案のidを載せる。担当者はこのidで
    // AI処理ログから元の問い合わせへ辿れる。
    logId: params.replyDraftId,
    failureReason: params.failureReason,
  };
}

/**
 * 1件通知する。同じ問い合わせで2度送らない(§10)。
 *
 * 冪等性は dedupeKey で担保する。Webhookの再送でも、画面からの再実行でも、
 * 既に SENT なら何もしない。
 */
export async function notifyInquiry(params: NotifyInquiryParams): Promise<NotifyResult> {
  const dedupeKey = buildDedupeKey({
    channel: params.channel,
    conversationId: params.conversationId,
    sourceMessageId: params.sourceMessageId,
  });

  try {
    const messages = buildNotificationMessages(toNotificationInput(params));

    // 既存レコードを先に見る。ここが失敗したら送らない —— 「分からない
    // から送っておく」にすると、Webhook再送のたびに重複通知が飛ぶ。
    const existing = await findDeliveryByDedupeKey(dedupeKey);
    const gate = canSend(existing);
    if (!gate.shouldRetry) {
      return { sent: false, status: gate.status, reason: gate.reason, deliveryId: existing?.id ?? null };
    }

    let delivery: NotificationDeliveryRecord;
    if (existing) {
      // 再試行時は最新の文面へ差し替える。前回失敗してから返信案が
      // 直っている可能性がある。
      delivery = await updateDeliveryContent({
        id: existing.id,
        summaryText: messages.summary,
        replyText: messages.reply,
        priority: messages.priority,
        replyDraftId: params.replyDraftId,
      });
    } else {
      delivery = await createPendingDelivery({
        dedupeKey,
        conversationId: params.conversationId,
        sourceMessageId: params.sourceMessageId,
        replyDraftId: params.replyDraftId,
        channel: params.channel,
        priority: messages.priority,
        summaryText: messages.summary,
        replyText: messages.reply,
        createdBy: params.createdBy,
      });
    }

    return await dispatch(delivery, messages.summary, messages.reply);
  } catch (err) {
    // ここへ来るのは通知の記録自体に失敗した場合。問い合わせ処理を
    // 巻き込まないよう、例外にせず結果として返す。
    const message = err instanceof Error ? err.message : String(err);
    console.error("[lineNotify] 通知の記録に失敗しました", { dedupeKey, message });
    return { sent: false, status: "FAILED", reason: `通知を記録できませんでした: ${message}`, deliveryId: null };
  }
}

/**
 * 実際にLINEへ送り、結果を記録する。
 *
 * attemptCount は**送信前**に増やす。送信中にプロセスが落ちても回数が
 * 残るので、無限に再試行され続けることがない(§8)。
 */
async function dispatch(
  delivery: NotificationDeliveryRecord,
  summary: string,
  reply: string | null,
): Promise<NotifyResult> {
  const settings = await getLineNotifySettings();
  const attemptCount = delivery.attemptCount + 1;
  const processing = await markDeliveryProcessing(delivery.id, attemptCount);

  try {
    // 2通を1リクエストで送る(client.ts のコメント参照)。1通目だけ届いて
    // 返信案が来ない、という中途半端な状態を作らない。
    await sendNotifyPush(settings.targetUserId ?? "", reply ? [summary, reply] : [summary]);
    const sent = await markDeliverySent(processing.id);
    await recordNotifyResult("SENT");
    return { sent: true, status: sent.status, reason: "通知しました。", deliveryId: sent.id };
  } catch (err) {
    const notifyErr =
      err instanceof LineNotifyError
        ? err
        : new LineNotifyError("UNKNOWN_REMOTE_ERROR", err instanceof Error ? err.message : String(err), true);
    const decision = decideAfterFailure({
      attemptCount,
      retryable: notifyErr.retryable,
      errorMessage: notifyErr.message,
    });
    const failed = await markDeliveryFailed(processing.id, decision.status, decision.reason);
    await recordNotifyResult(decision.status);
    console.error("[lineNotify] 送信に失敗しました", {
      deliveryId: failed.id,
      code: notifyErr.code,
      attemptCount,
      max: MAX_DELIVERY_ATTEMPTS,
    });
    return { sent: false, status: failed.status, reason: decision.reason, deliveryId: failed.id };
  }
}

/**
 * 画面からの手動再送。DEAD_LETTER も含めて送り直せるようにする ——
 * 原因(トークン切れ等)を直した後に、溜まった通知を人が流せる必要がある。
 */
export async function retryDelivery(deliveryId: string): Promise<NotifyResult> {
  const reset = await resetDeliveryForRetry(deliveryId);
  if (!reset.summaryText) {
    return { sent: false, status: "DEAD_LETTER", reason: "送信する本文が残っていません。", deliveryId };
  }
  return dispatch({ ...reset, attemptCount: 0 }, reset.summaryText, reset.replyText);
}

/**
 * §35 テスト送信。**本番のInquiryを作らない。**
 *
 * NotificationDelivery も作らない —— テストのたびに履歴が増えると、
 * AI処理ログで本物の通知が埋もれる。送って結果を返すだけにする。
 */
export async function sendTestNotification(): Promise<{ ok: boolean; message: string }> {
  const settings = await getLineNotifySettings();
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const summary = [
    "【テスト送信 / 要確認】",
    "",
    "■ お問い合わせ内容",
    "お名前：テスト太郎様",
    "",
    "これはBELLO在庫管理システムからのテスト通知です。実際のお問い合わせではありません。",
    "",
    "■ 対象商品",
    "特定できませんでした",
    "",
    "■ 配送情報",
    "配送先：不明",
    "想定送料：不明",
    "",
    "■ 問い合わせ判定",
    "テスト",
    "",
    "■ 要確認の理由",
    "・テスト送信のため、返信は不要です。",
    "",
    `送信日時：${now}`,
  ].join("\n");
  const reply = ["【返信提案】", "", "これはテスト送信です。お客様へ送信しないでください。"].join("\n");

  try {
    await sendNotifyPush(settings.targetUserId ?? "", [summary, reply]);
    await recordNotifyResult("SENT(テスト送信)");
    return { ok: true, message: `テスト通知を2通送信しました(宛先: ${settings.targetDisplayName ?? settings.targetUserId})。` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordNotifyResult("FAILED(テスト送信)");
    return { ok: false, message };
  }
}
