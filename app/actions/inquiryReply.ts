"use server";

import { randomUUID } from "node:crypto";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { generateInquiryReplyDraft } from "@/lib/inquiry/pipeline";
import { latestReplyDraftFor, markReplyDraftStatus, saveReplyDraft } from "@/lib/inquiry/draftStore";
import { getAIReplySettings } from "@/lib/inquiry/settings";
import type { ReplyDraftRecord } from "@/lib/inquiry/types";

/**
 * §14/§16/§34 AI返信案のServer Action層。
 *
 * 【生成と送信を一体化しない】この層は返信案を作って保存するだけで、
 * 顧客へは何も送らない。送信は既存のdraftReplyAction/sendReplyAction
 * (app/actions/messaging.ts、送信前の確認モーダルを伴う)がそのまま
 * 担当する —— §41「今回の実装では自動送信をOFF」を、フラグではなく
 * 「送信する経路がこのファイルに存在しない」という形で担保する。
 *
 * 【一覧を開いただけでAIを呼ばない】§15/§31。取得系
 * (getInquiryReplyDraftAction)はDBに保存済みの案を返すだけで、
 * 生成は明示的なボタン操作(generateInquiryReplyAction)からしか起きない。
 */

function logActionFailure(action: string, correlationId: string, context: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      context,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function requireEditPermission(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  return getCurrentInventoryUserEmail();
}

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; correlationId: string };

/**
 * 会話の最新の受信メッセージに対する、保存済みの返信案を返す。
 * 無ければnull(生成はしない)。
 */
export async function getInquiryReplyDraftAction(conversationId: string): Promise<ActionResult<ReplyDraftRecord | null>> {
  const correlationId = randomUUID();
  try {
    await requireEditPermission();
    const messages = await listMessages(conversationId);
    const latestIncoming = [...messages].reverse().find((m) => m.direction === "INBOUND");
    if (!latestIncoming) return { ok: true, data: null };
    return { ok: true, data: await latestReplyDraftFor(conversationId, latestIncoming.id) };
  } catch (err) {
    logActionFailure("getInquiryReplyDraftAction", correlationId, { conversationId }, err);
    return { ok: false, error: safeErrorMessage(err, "返信案の取得に失敗しました。"), correlationId };
  }
}

/**
 * 返信案を生成して保存する(§34 再生成・商品変更もこの1関数)。
 *
 * overrideInventoryIdを渡すと、自動特定を上書きして その商品で作り直す。
 * 古い商品の情報を使い続けないよう、生成は毎回すべての段階をやり直す。
 */
export async function generateInquiryReplyAction(
  conversationId: string,
  options?: { overrideInventoryId?: string | null },
): Promise<ActionResult<ReplyDraftRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireEditPermission();
    const conversation = await getConversation(conversationId);
    if (!conversation) throw new Error("対象の会話が見つかりません。");

    const messages = await listMessages(conversationId);
    const latestIncoming = [...messages].reverse().find((m) => m.direction === "INBOUND");
    if (!latestIncoming) throw new Error("返信対象となる受信メッセージがありません。");

    const result = await generateInquiryReplyDraft({
      channel: conversation.channel,
      conversationId,
      messageId: latestIncoming.id,
      messageText: latestIncoming.body,
      history: messages.slice(-10).map((m) => ({ direction: m.direction, body: m.body })),
      overrideInventoryId: options?.overrideInventoryId ?? null,
      conversationInventoryId: conversation.relatedInventoryId,
    });

    const saved = await saveReplyDraft(
      {
        conversationId,
        sourceMessageId: latestIncoming.id,
        resolvedInventoryId: result.evidence.product?.inventoryId ?? null,
        productMatchConfidence: result.evidence.product?.confidence ?? null,
        intents: result.intents,
        draftText: result.draftText,
        unresolvedFacts: result.unresolvedFacts,
        evidence: result.evidence,
        modelProvider: result.modelProvider,
        modelName: result.modelName,
        status: result.status,
        failureReason: result.failureReason,
      },
      who,
    );
    return { ok: true, data: saved };
  } catch (err) {
    logActionFailure("generateInquiryReplyAction", correlationId, { conversationId }, err);
    return { ok: false, error: safeErrorMessage(err, "返信案の生成に失敗しました。時間をおいて再試行してください。"), correlationId };
  }
}

/** 返信欄へ反映した(USED)／破棄した(DISMISSED)ことを記録する。 */
export async function markInquiryReplyDraftAction(draftId: string, status: "USED" | "DISMISSED"): Promise<ActionResult<true>> {
  const correlationId = randomUUID();
  try {
    const who = await requireEditPermission();
    await markReplyDraftStatus(draftId, status, who);
    return { ok: true, data: true };
  } catch (err) {
    logActionFailure("markInquiryReplyDraftAction", correlationId, { draftId, status }, err);
    return { ok: false, error: safeErrorMessage(err, "返信案の状態更新に失敗しました。"), correlationId };
  }
}

/** UIがボタンの活性・注意書きを決めるために読む。 */
export async function getInquiryReplyAvailabilityAction(): Promise<ActionResult<{ autoDraftEnabled: boolean; webResearchEnabled: boolean; knowledgeEnabled: boolean }>> {
  const correlationId = randomUUID();
  try {
    await requireEditPermission();
    const settings = await getAIReplySettings();
    return {
      ok: true,
      data: {
        autoDraftEnabled: settings.autoDraftEnabled,
        webResearchEnabled: settings.webResearchEnabled,
        knowledgeEnabled: settings.knowledgeEnabled,
      },
    };
  } catch (err) {
    logActionFailure("getInquiryReplyAvailabilityAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "AI返信設定の取得に失敗しました。"), correlationId };
  }
}
