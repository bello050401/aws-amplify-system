"use server";

import { revalidatePath } from "next/cache";
import { getLineOutboundStatus } from "@/lib/messaging/line/outboundGuard";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  listConversations,
  listRecentMessages,
  setConversationCompleted,
  type ConversationScope,
  type MessagePage,
  listMessages,
  createTestConversation,
  draftReply,
  sendReply,
  resolveConversation,
  markConversationRead,
  setConversationWorkflowStatus,
  softDeleteConversation,
} from "@/lib/messaging/service";
import { ATTACHMENT_PREFIX, createAttachmentViewUrl } from "@/lib/messaging/attachmentStore";
import type { ConversationRecord, ConversationWorkflowStatus, MessageRecord } from "@/lib/messaging/types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message coreのServer
 * Action層。閲覧はADMIN/EDITOR/VIEWERいずれも可(既存のEC出品閲覧と
 * 同じ境界)、下書き作成・送信・解決マークはcanEditInventory
 * (ADMIN/EDITOR)、テスト会話作成のみADMIN限定(実データに影響しない
 * 完全ローカルな機能とはいえ、テストデータを増やす操作なのでZAICO同期
 * の「1件同期」等と同じADMIN限定にする)。
 */
async function requireEditPermission(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  return getCurrentInventoryUserEmail();
}

async function requireAdmin(): Promise<string | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
  return getCurrentInventoryUserEmail();
}

export async function listConversationsAction(scope: ConversationScope = "ACTIVE"): Promise<ConversationRecord[]> {
  return listConversations(scope);
}

/**
 * 「対応済み」タブを押したときだけ呼ぶ(指示書§14)。
 * 通常の一覧では対応済みを一切読まないので、蓄積しても初期表示が
 * 重くならない。
 */
export async function listCompletedConversationsAction(): Promise<ConversationRecord[]> {
  const role = await getInventoryRole();
  if (!role) throw new Error("ログインが必要です。");
  return listConversations("COMPLETED");
}

/** 会話を「対応済み」にする/解除する。Message・画像は一切削除しない。 */
export async function setConversationCompletedAction(conversationId: string, completed: boolean): Promise<void> {
  const who = await requireEditPermission();
  await setConversationCompleted(conversationId, completed, who);
  revalidatePath("/inventory/messages");
}

/** LINEへの実送信が有効かどうか(UIの送信ボタンの活殺と説明文に使う)。 */
export async function getLineOutboundStatusAction(): Promise<{ enabled: boolean; message: string }> {
  return getLineOutboundStatus();
}

export async function listMessagesAction(conversationId: string): Promise<MessageRecord[]> {
  return listMessages(conversationId);
}

/**
 * 会話を開いたときに読む分だけ取得する(指示書§16)。
 * 画面はこちらを使い、全件版は送信・AI生成など全件が要る処理だけが使う。
 */
export async function listRecentMessagesAction(conversationId: string, limit?: number): Promise<MessagePage> {
  return listRecentMessages(conversationId, limit);
}

export async function createTestConversationAction(input: { customerDisplayName: string; body: string }): Promise<ConversationRecord> {
  const who = await requireAdmin();
  const result = await createTestConversation(input, who);
  revalidatePath("/inventory/messages");
  return result;
}

export async function draftReplyAction(conversationId: string, body: string, aiGenerated: boolean): Promise<MessageRecord> {
  const who = await requireEditPermission();
  const result = await draftReply(conversationId, body, aiGenerated, who);
  revalidatePath("/inventory/messages");
  return result;
}

export async function sendReplyAction(conversationId: string, messageId: string): Promise<MessageRecord> {
  const who = await requireEditPermission();
  const result = await sendReply(conversationId, messageId, who);
  // 2026-09-02 指示書§24: 「返信済み」を業務ステータスとして書かない。
  //
  // 返信したかどうかは Conversation.needsReply(= 最新の受信より後に
  // BELLOから送信したか)から導く事実で、業務ステータス
  // (大原確認/市川確認/対応済み)とは別の軸。同じ1つのフィールドへ
  // 両方を書くと、「大原確認中だが未返信」という実在する状態を
  // 表現できなくなる。needsReply は sendReply が送信成功時に更新する。
  revalidatePath("/inventory/messages");
  return result;
}

/**
 * 人が会話を開いた。**この経路以外から既読にしない** ——
 * AI生成・Webhook・一覧の描画では呼ばない(§5)。
 */
export async function markConversationReadAction(conversationId: string): Promise<void> {
  const who = await requireEditPermission();
  await markConversationRead(conversationId, who);
  revalidatePath("/inventory/messages");
}

/** 業務ステータスの手動変更。 */
export async function setConversationWorkflowStatusAction(conversationId: string, status: ConversationWorkflowStatus): Promise<void> {
  const who = await requireEditPermission();
  await setConversationWorkflowStatus(conversationId, status, who);
  revalidatePath("/inventory/messages");
}

/**
 * 会話の削除。論理削除で、外部サービス側のメッセージには触れない。
 * ADMIN限定にしているのは、監査対象になり得るデータを画面から見えなく
 * する操作だから。
 */
export async function deleteConversationAction(conversationId: string): Promise<void> {
  const who = await requireAdmin();
  await softDeleteConversation(conversationId, who);
  revalidatePath("/inventory/messages");
}

export async function resolveConversationAction(conversationId: string): Promise<void> {
  const who = await requireEditPermission();
  await resolveConversation(conversationId, who);
  revalidatePath("/inventory/messages");
}

/**
 * 受信画像の表示用URLを作る。
 *
 * バケットは非公開なので、キーをそのまま <img src> にはできない。
 * サーバー側で期限付きの署名付きURLを作って渡す。
 *
 * 【範囲を絞る】messaging/attachments/ 配下のキーしか受け付けない ——
 * 引数はクライアント由来なので、任意のキーを渡されてバケット内の別の場所
 * (在庫画像・ナレッジ原本)を読まれないようにする。
 */
export async function getMessageAttachmentUrlAction(
  storageKey: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const role = await getInventoryRole();
    if (!role) return { ok: false, error: "ログインが必要です。" };

    const key = typeof storageKey === "string" ? storageKey : "";
    if (!key.startsWith(`${ATTACHMENT_PREFIX}/`) || key.includes("..")) {
      return { ok: false, error: "この添付は表示できません。" };
    }

    return { ok: true, url: await createAttachmentViewUrl(key) };
  } catch (err) {
    console.error("[getMessageAttachmentUrlAction] failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "画像のURLを作成できませんでした。" };
  }
}
