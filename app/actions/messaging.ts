"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  listConversations,
  listMessages,
  createTestConversation,
  draftReply,
  sendReply,
  resolveConversation,
  markConversationRead,
  setConversationWorkflowStatus,
  softDeleteConversation,
} from "@/lib/messaging/service";
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

export async function listConversationsAction(): Promise<ConversationRecord[]> {
  return listConversations();
}

export async function listMessagesAction(conversationId: string): Promise<MessageRecord[]> {
  return listMessages(conversationId);
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
  // 返信が実際に送れたときだけ「返信済み」へ進める(§6の自動化)。
  // 送信に失敗した場合はここへ来ないので、嘘のステータスにならない。
  // 記録に失敗しても送信自体は成功しているので、そこで例外にはしない。
  try {
    await setConversationWorkflowStatus(conversationId, "REPLIED", who);
  } catch (err) {
    console.error("[sendReplyAction] 業務ステータスの更新に失敗:", err instanceof Error ? err.message : err);
  }
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
