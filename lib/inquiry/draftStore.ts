import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { InquiryIntent, ReplyDraftRecord, ReplyDraftStatus, ReplyEvidence, UnresolvedFact } from "./types";

/**
 * §17 生成した返信案の保存。
 *
 * 【何を保存し、何を保存しないか】
 *  - 保存する: 返信案の本文、対象商品、確度、種別、不明点、根拠の「参照」
 *  - 保存しない: 顧客のメッセージ本文、外部ページの取得内容、Secret
 *
 * 顧客本文はMessageモデルに既に一次情報として存在するので、ここへ複製
 * すると同じ個人情報が2箇所に増えるだけになる(§17末尾)。外部ページの
 * 本文は再取得できるうえ、そのままだと第三者の著作物を無制限に溜め込む
 * ことになるため、URLとタイトルだけを残す。
 */

interface ReplyDraftRow {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  resolvedInventoryId?: string | null;
  productMatchConfidence?: number | null;
  intents?: unknown;
  draftText?: string | null;
  unresolvedFacts?: unknown;
  sourceSummary?: unknown;
  modelProvider?: string | null;
  modelName?: string | null;
  status: ReplyDraftStatus;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: ReplyDraftRow): ReplyDraftRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sourceMessageId: row.sourceMessageId,
    resolvedInventoryId: row.resolvedInventoryId ?? null,
    productMatchConfidence: row.productMatchConfidence ?? null,
    intents: parseJson<InquiryIntent[]>(row.intents) ?? [],
    draftText: row.draftText ?? null,
    unresolvedFacts: parseJson<UnresolvedFact[]>(row.unresolvedFacts) ?? [],
    evidence: parseJson<ReplyEvidence>(row.sourceSummary),
    modelProvider: row.modelProvider ?? null,
    modelName: row.modelName ?? null,
    status: row.status,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * a.json()フィールドは、書いたときの型そのままで返るとは限らない
 * (AppSyncを経由すると文字列で返ることがある)。両方を受ける。
 */
function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

export async function listReplyDrafts(conversationId: string): Promise<ReplyDraftRecord[]> {
  const { data, errors } = await serverDataClient.models.ReplyDraft.list({
    filter: { conversationId: { eq: conversationId } },
    limit: 50,
    ...inventoryAuthMode,
  });
  if (errors) throw new Error(`返信案の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return (data as unknown as ReplyDraftRow[]).map(toRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * idで1件引く。AI処理ログが「この通知の根拠」を出すために使う。
 *
 * 通知(NotificationDelivery)は replyDraftId しか持っていないので、
 * 特定できた商品・使ったナレッジ・適用したルールを見るには、ここから
 * evidence を取り直す必要がある。
 */
export async function getReplyDraft(id: string): Promise<ReplyDraftRecord | null> {
  const { data, errors } = await serverDataClient.models.ReplyDraft.get({ id }, inventoryAuthMode);
  if (errors) throw new Error(`返信案の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return data ? toRecord(data as unknown as ReplyDraftRow) : null;
}

/** その受信メッセージに対する最新の返信案(無ければnull)。 */
export async function latestReplyDraftFor(conversationId: string, sourceMessageId: string): Promise<ReplyDraftRecord | null> {
  const drafts = await listReplyDrafts(conversationId);
  return drafts.find((d) => d.sourceMessageId === sourceMessageId) ?? null;
}

export interface SaveReplyDraftInput {
  conversationId: string;
  sourceMessageId: string;
  resolvedInventoryId: string | null;
  productMatchConfidence: number | null;
  intents: InquiryIntent[];
  draftText: string | null;
  unresolvedFacts: UnresolvedFact[];
  evidence: ReplyEvidence;
  modelProvider: string | null;
  modelName: string | null;
  status: ReplyDraftStatus;
  failureReason: string | null;
}

/**
 * 同じ受信メッセージへの返信案は作り直しても1行に保つ(§21 重複生成防止)。
 *
 * 再生成のたびに行が増えると、どれが最新か画面側で判断する必要が出て、
 * 「古い案を送ってしまう」事故の余地ができる。履歴が要るのは
 * 「送信した内容」であって、それはMessage側に残る。
 */
export async function saveReplyDraft(input: SaveReplyDraftInput, who: string | null): Promise<ReplyDraftRecord> {
  const existing = await latestReplyDraftFor(input.conversationId, input.sourceMessageId);
  const payload = {
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    resolvedInventoryId: input.resolvedInventoryId,
    productMatchConfidence: input.productMatchConfidence,
    intents: JSON.stringify(input.intents),
    draftText: input.draftText,
    unresolvedFacts: JSON.stringify(input.unresolvedFacts),
    sourceSummary: JSON.stringify(input.evidence),
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    status: input.status,
    failureReason: input.failureReason,
    updatedBy: who,
  };

  if (existing) {
    const { data, errors } = await serverDataClient.models.ReplyDraft.update({ id: existing.id, ...payload }, inventoryAuthMode);
    if (errors || !data) throw new Error(errors?.[0]?.message ?? "返信案の保存に失敗しました。");
    return toRecord(data as unknown as ReplyDraftRow);
  }
  const { data, errors } = await serverDataClient.models.ReplyDraft.create({ ...payload, createdBy: who }, inventoryAuthMode);
  if (errors || !data) throw new Error(errors?.[0]?.message ?? "返信案の保存に失敗しました。");
  return toRecord(data as unknown as ReplyDraftRow);
}

/** 返信欄へ反映して送信に使った、または破棄した、という記録(§18)。 */
export async function markReplyDraftStatus(id: string, status: ReplyDraftStatus, who: string | null): Promise<void> {
  const { errors } = await serverDataClient.models.ReplyDraft.update({ id, status, updatedBy: who }, inventoryAuthMode);
  if (errors) throw new Error(errors[0]?.message ?? "返信案の更新に失敗しました。");
}
