"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listConversations, listMessages, createTestConversation, draftReply, sendReply, resolveConversation } from "@/lib/messaging/service";
import type { ConversationRecord, MessageRecord } from "@/lib/messaging/types";

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
  revalidatePath("/inventory/messages");
  return result;
}

export async function resolveConversationAction(conversationId: string): Promise<void> {
  const who = await requireEditPermission();
  await resolveConversation(conversationId, who);
  revalidatePath("/inventory/messages");
}
