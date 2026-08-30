/**
 * BELLO統合業務OS指示書(2026-08-30) §42/§121: 「返信済み」の定義・
 * 一覧のdefaultソート。純粋なロジックのみ(lib/inventory/sales.ts/
 * lib/listing/pricing.tsと同じ方針) — AWS/Amplifyへ一切触れない、
 * DB取得・書き込みは呼び出し元(lib/messaging/service.ts)の責務。
 */

import type { ConversationRecord, ConversationStatus } from "./types";

/**
 * §42: 「Conversationを開いただけでは返信済みにしない。最新incoming
 * より後にsuccessful outgoingがある → REPLIED。send failure →
 * needsReply=true。顧客から新incoming → needsReply=trueへ戻す。」
 *
 * `lastOutgoingAt`は呼び出し元(lib/messaging/service.ts)が「成功した
 * 送信のみ」で更新する値である前提(送信失敗はlastOutgoingAtを更新
 * しない — これによりこの関数自体は成功/失敗を意識せず、単純な時刻
 * 比較だけで正しく動く)。
 */
export function deriveNeedsReply(lastIncomingAt: string | null, lastOutgoingAt: string | null): boolean {
  if (!lastIncomingAt) return false; // まだ何も受信していない(新規作成直後等)
  if (!lastOutgoingAt) return true; // 受信はあるが一度も返信していない
  return new Date(lastOutgoingAt).getTime() < new Date(lastIncomingAt).getTime();
}

/**
 * needsReplyの真偽値から、RESOLVED/ARCHIVED(どちらもユーザーの明示的
 * な操作でのみ遷移する、このタイムライン計算の対象外 — 呼び出し元が
 * 現在の値をそのまま維持する)を除いた3状態を導出する。
 */
export function deriveConversationStatus(
  needsReply: boolean,
  hasAnyIncoming: boolean,
  currentStatus: ConversationStatus,
): ConversationStatus {
  if (currentStatus === "RESOLVED" || currentStatus === "ARCHIVED") return currentStatus;
  if (!hasAnyIncoming) return "OPEN";
  return needsReply ? "WAITING_FOR_REPLY" : "REPLIED";
}

/** §80: 一覧では全文ではなくpreviewだけを見せる — 長いメッセージ本文を安全に切り詰める。改行はスペースへ畳み込む(一覧の1行表示を崩さないため)。 */
export function buildMessagePreview(body: string, maxLength = 60): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

/**
 * §121: 「要返信 ↓ 最新incoming」を優先。返信済みが未返信を埋もれさせ
 * ない — needsReply:trueを常に先頭グループへ、グループ内は
 * lastMessageAt降順(直近の動きがあったものを上に)。
 */
export function sortConversations<T extends Pick<ConversationRecord, "needsReply" | "lastMessageAt" | "id">>(conversations: T[]): T[] {
  return [...conversations].sort((a, b) => {
    if (a.needsReply !== b.needsReply) return a.needsReply ? -1 : 1;
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.id < b.id ? -1 : 1; // 同時刻は安定ソート(毎回順序が変わらないように)
  });
}
