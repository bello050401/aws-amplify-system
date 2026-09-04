import "server-only";
import type { InquiryIntent, ReplyDraftStatus, ReplyEvidence } from "@/lib/inquiry/types";
import type { DeliveryWindowState } from "@/lib/inquiry/deliveryWindow";
import type { MessageChannel } from "@/lib/messaging/types";
import { LineNotifyError, sendNotifyPush } from "./client";
import { buildDedupeKey, canSend, decideAfterFailure, MAX_DELIVERY_ATTEMPTS } from "./deliveryPolicy";
import {
  claimPendingDelivery,
  findDeliveryByDedupeKey,
  markDeliveryFailed,
  markDeliveryProcessing,
  markDeliverySent,
  listRecentDeliveries,
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
  /** メール由来の問い合わせ種別(§9)。 */
  inquiryKind?: "PRODUCT_INQUIRY" | "ORDER_MESSAGE" | null;
  /** 取引メッセージの注文番号(§9)。 */
  orderNumber?: string | null;
  /** 注文から確定している商品(2026-09-04 §58)。在庫が引けなくても通知へ出す。 */
  orderProduct?: { productName: string; orderId: string } | null;
  /** 本文の抽出に失敗しているか(§3/§7 解析状態の記録に使う)。 */
  parseFailed?: boolean;
  /** 会話から引き継いだ情報(§27)。1通目に出す。 */
  carriedFacts?: { label: string; value: string }[];
  /** 今回のメッセージで解消した確認事項(§22)。 */
  answeredQuestions?: string[];
  /** 商品情報の補完(§33)。 */
  productContextNotes?: string[];
  /** 会話文脈の読み書きで起きた問題。 */
  contextIssues?: string[];
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
    inquiryKind: params.inquiryKind ?? null,
    orderNumber: params.orderNumber ?? null,
    orderProduct: params.orderProduct ?? null,
    carriedFacts: params.carriedFacts ?? [],
    answeredQuestions: params.answeredQuestions ?? [],
    productContextNotes: params.productContextNotes ?? [],
    contextIssues: params.contextIssues ?? [],
  };
}

/**
 * 解析側の状態(§7)。**通知の成否とは別軸。**
 *
 * 通知先が未登録なだけの通知が「停止(要対応)」と表示され、解析まで失敗した
 * ように見えていた。解析がどこまで進んだかをここで確定させ、通知の状態と
 * 並べて出せるようにする。
 */
function analysisStatusFor(params: NotifyInquiryParams): string {
  if (params.parseFailed) return "PARSE_FAILED";
  if (params.failureReason) return "GENERATION_FAILED";
  const review = decideReview({
    draftStatus: params.draftStatus,
    evidence: params.evidence,
    deliveryWindowState: params.deliveryWindowState,
    generationFailed: false,
  });
  return review.needsHumanReview ? "NEEDS_REVIEW" : "OK";
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
      // 「無いことを確かめてから作る」の隙間で追い越されると2通送る。
      // dedupeKey を id にした条件付き作成で、勝った側だけが送る
      // (PHASE 9 — deliveryStore.ts の claimPendingDelivery のコメント)。
      const claim = await claimPendingDelivery({
        dedupeKey,
        conversationId: params.conversationId,
        sourceMessageId: params.sourceMessageId,
        replyDraftId: params.replyDraftId,
        channel: params.channel,
        priority: messages.priority,
        summaryText: messages.summary,
        replyText: messages.reply,
        createdBy: params.createdBy,
        analysisStatus: analysisStatusFor(params),
        inquiryKind: params.inquiryKind ?? null,
        orderNumber: params.orderNumber ?? null,
      });
      if (!claim.claimed) {
        // 追い越された。勝った側が送るので、こちらは送らない。
        // 勝った側が送信前に落ちても、次の再送・再実行が PENDING の
        // この行を見つけて再試行する(canSend が PENDING を通す)。
        return {
          sent: false,
          status: claim.record.status,
          reason: "別の処理が同じ通知を作成済みです。重複して送りません。",
          deliveryId: claim.record.id,
        };
      }
      delivery = claim.record;
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
      // §7 通知先未登録は解析失敗でも恒久停止でもない。
      noTarget: notifyErr.code === "NO_TARGET",
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
 * 通知先の登録待ちだったものをまとめて送る(2026-09-03 追加指示§7)。
 *
 * ── 古いものを一気に送らない ────────────────────────────────────
 *
 * §7末尾。友だち追加した瞬間に何十件も届くと、どれが今対応すべき
 * 問い合わせなのか分からなくなり、通知そのものが役に立たなくなる。
 * **期間と件数の両方**に上限を設ける。上限を超えた分は
 * WAITING_FOR_TARGET のまま残るので、画面から個別に再送できる。
 */
export const RESEND_MAX_COUNT = 10;
export const RESEND_MAX_AGE_HOURS = 48;

export async function resendWaitingDeliveries(): Promise<{ sent: number; skipped: number; failed: number; message: string }> {
  const settings = await getLineNotifySettings();
  if (!settings.targetUserId) {
    return { sent: 0, skipped: 0, failed: 0, message: "通知先が未登録のため送信できません。先に友だち追加してください。" };
  }

  const all = await listRecentDeliveries(200);
  const cutoff = Date.now() - RESEND_MAX_AGE_HOURS * 3600_000;
  // NOT_REQUIRED / SUPERSEDED は対象にしない。バックフィル・検証で作られた
  // 履歴が、通知先の登録をきっかけに一斉に飛ぶのを防ぐ(利用者の指示)。
  // 本物の新規問い合わせが一時的に送れなかった場合は WAITING_FOR_TARGET の
  // ままなので、この経路で再送できる。
  const waiting = all
    .filter((d) => d.status === "WAITING_FOR_TARGET" || d.status === "PENDING")
    .filter((d) => new Date(d.createdAt).getTime() >= cutoff)
    // 古い順に送る。届く順番が問い合わせの順番と一致するほうが読みやすい。
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const targets = waiting.slice(0, RESEND_MAX_COUNT);
  const skipped = waiting.length - targets.length;

  let sent = 0;
  let failed = 0;
  for (const d of targets) {
    if (!d.summaryText) {
      failed++;
      continue;
    }
    const r = await dispatch({ ...d, attemptCount: 0 }, d.summaryText, d.replyText);
    if (r.sent) sent++;
    else failed++;
  }

  const parts = [`${sent}件送信`, failed > 0 ? `${failed}件失敗` : null, skipped > 0 ? `${skipped}件は上限のため未送信` : null]
    .filter(Boolean)
    .join(" / ");
  const note =
    skipped > 0
      ? `（1回あたり最大${RESEND_MAX_COUNT}件、過去${RESEND_MAX_AGE_HOURS}時間以内のものだけを送ります。残りは再度実行するか、個別に再送してください。）`
      : "";
  return { sent, skipped, failed, message: `${parts || "対象がありませんでした"}${note}` };
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
