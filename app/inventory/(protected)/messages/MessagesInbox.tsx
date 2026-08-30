"use client";

import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { useEffect, useState } from "react";
import {
  createTestConversationAction,
  draftReplyAction,
  listMessagesAction,
  resolveConversationAction,
  sendReplyAction,
} from "@/app/actions/messaging";
import { generateReplyDraftAction } from "@/app/actions/ai";
import type { ConversationRecord, MessageRecord } from "@/lib/messaging/types";

type Filter = "ALL" | "NEEDS_REPLY" | "REPLIED" | "RESOLVED";

const CHANNEL_LABEL: Record<ConversationRecord["channel"], string> = {
  MERCARI_SHOPS: "Mercari",
  YAHOO_AUCTION: "Yahoo!オークション",
  LINE: "LINE",
  EMAIL: "Email",
  TEST: "テスト",
};

const STATUS_LABEL: Record<ConversationRecord["status"], string> = {
  OPEN: "新規",
  WAITING_FOR_REPLY: "要返信",
  REPLIED: "返信済み",
  RESOLVED: "解決済み",
  ARCHIVED: "アーカイブ",
};

/**
 * BELLO統合業務OS指示書(2026-08-30) §43/§44/§45/§46: Message Inbox UI
 * (desktop)。header/filter/list/detail(timeline+下書き編集+送信前確認)
 * を1コンポーネントにまとめている — この画面の想定規模(§79と同様
 * 「1000+」ではなく会話単位、EC出品一覧ほどの件数にはならない)なら
 * page全体を分割するほどの複雑さではないという判断。
 */
export function MessagesInbox({
  initialConversations,
  canEdit,
  isAdmin,
}: {
  initialConversations: ConversationRecord[];
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(initialConversations[0]?.id ?? null);
  // BELLO統合業務OS指示書(2026-08-30) §70/§78: モバイル幅では一覧と
  // 詳細を横並びにする余地が無い(w-72の一覧だけで390pxの大半を占めて
  // しまう) — selectedIdとは独立に「今どちらの画面を見せるか」を持つ。
  // デスクトップ(`md:`以上)ではこの値を無視して常に両方表示する。
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingMessageId, setConfirmingMessageId] = useState<string | null>(null);
  const [showTestForm, setShowTestForm] = useState(false);
  const [testCustomer, setTestCustomer] = useState("");
  const [testBody, setTestBody] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [isAiDraft, setIsAiDraft] = useState(false);

  const filtered = conversations.filter((c) => {
    if (filter === "NEEDS_REPLY") return c.needsReply;
    if (filter === "REPLIED") return c.status === "REPLIED";
    if (filter === "RESOLVED") return c.status === "RESOLVED" || c.status === "ARCHIVED";
    return true;
  });
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  async function loadMessages(conversationId: string) {
    setMessagesLoading(true);
    try {
      setMessages(await listMessagesAction(conversationId));
    } finally {
      setMessagesLoading(false);
    }
  }

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
    setReplyBody("");
    setIsAiDraft(false);
    setConfirmingMessageId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function handleSaveDraft() {
    if (!selected || !replyBody.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await draftReplyAction(selected.id, replyBody, isAiDraft);
      setReplyBody("");
      setIsAiDraft(false);
      await loadMessages(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下書きの保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * §45/§89: AI generates ↓ human edits ↓ send click ↓ confirmation ↓
   * external send。ここではdraftを生成してテキストエリアへ入れるだけ
   * — 保存も送信もしない。このボタンを押すまでAI requestは発生しない。
   */
  // 第六ラウンドP0-1: generateReplyDraftActionはもう例外をthrowせず
  // `{ok, ...}`を返す(app/actions/ai.tsのコメント参照)。
  async function handleGenerateReply() {
    if (!selected) return;
    setAiBusy(true);
    setError(null);
    try {
      const result = await generateReplyDraftAction(selected.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReplyBody(result.data);
      setIsAiDraft(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI生成に失敗しました。");
    } finally {
      setAiBusy(false);
    }
  }

  // §46: 送信前最終確認 — 「この内容で送信してもよろしいですか？」を
  // 挟まないと送信できない。confirmingMessageIdがセットされている間
  // だけモーダルを表示する。
  async function handleConfirmSend(messageId: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await sendReplyAction(selected.id, messageId);
      await loadMessages(selected.id);
      setConfirmingMessageId(null);
      // 一覧側のneedsReply/statusも変わっているはずなので、選択中の
      // 会話だけ簡易的に更新する(全件再取得はしない — §80のperformance
      // 方針に合わせる)。
      setConversations((prev) =>
        prev.map((c) => (c.id === selected.id ? { ...c, needsReply: false, status: "REPLIED" as const } : c)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました。");
      setConfirmingMessageId(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleResolve() {
    if (!selected) return;
    setBusy(true);
    try {
      await resolveConversationAction(selected.id);
      setConversations((prev) => prev.map((c) => (c.id === selected.id ? { ...c, status: "RESOLVED" as const, needsReply: false } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateTest() {
    setBusy(true);
    setError(null);
    try {
      const created = await createTestConversationAction({ customerDisplayName: testCustomer, body: testBody });
      setConversations((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setShowTestForm(false);
      setTestCustomer("");
      setTestBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "テスト会話の作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  const draftMessage = messages.find((m) => m.deliveryStatus === "DRAFT");

  return (
    <div className="flex min-h-0 flex-1">
      {/* 一覧(§43)。モバイルでは詳細を見ている間`hidden`にする(§78)。 */}
      <div className={`w-full shrink-0 flex-col border-r border-gray-200 md:flex md:w-72 ${mobileView === "detail" ? "hidden" : "flex"}`}>
        <div className="flex items-center gap-1 border-b border-gray-200 px-2 py-1.5 text-[11px]">
          {(["ALL", "NEEDS_REPLY", "REPLIED", "RESOLVED"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              // 実測45x21 — 4つが横に並ぶので、モバイルでは押し分けに
              // 高さが要る。文字サイズは据え置きで高さだけ32pxへ。
              className={`inline-flex min-h-8 items-center px-2 py-0.5 ${filter === f ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}
            >
              {{ ALL: "すべて", NEEDS_REPLY: "要返信", REPLIED: "返信済み", RESOLVED: "解決済み" }[f]}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 && <p className="p-4 text-center text-[12px] text-gray-400">会話がありません。</p>}
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSelectedId(c.id);
                setMobileView("detail");
              }}
              className={`block w-full border-b border-gray-100 px-3 py-2 text-left ${selectedId === c.id ? "bg-gray-100" : "hover:bg-gray-50"}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">{CHANNEL_LABEL[c.channel]}</span>
                {c.needsReply && <span className="h-1.5 w-1.5 rounded-full bg-red-600" aria-label="要返信" />}
              </div>
              <p className="truncate text-[13px] font-bold text-gray-900">{c.customerDisplayName ?? "不明な顧客"}</p>
              <p className="truncate text-[12px] text-gray-500">{c.lastMessagePreview ?? "（本文なし）"}</p>
              <p className="mt-0.5 text-[10px] text-gray-400">
                {STATUS_LABEL[c.status]} ・ {c.lastMessageAt ? formatJstDateTime(c.lastMessageAt) : ""}
              </p>
            </button>
          ))}
        </div>
        {isAdmin && (
          <div className="border-t border-gray-200 p-2">
            {!showTestForm ? (
              <button type="button" onClick={() => setShowTestForm(true)} className="w-full border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50">
                テスト会話を作成
              </button>
            ) : (
              <div className="space-y-1">
                <input
                  value={testCustomer}
                  onChange={(e) => setTestCustomer(e.target.value)}
                  placeholder="顧客名"
                  className="w-full border border-gray-300 px-2 py-1 text-[11px]"
                />
                <textarea
                  value={testBody}
                  onChange={(e) => setTestBody(e.target.value)}
                  placeholder="問い合わせ本文"
                  rows={2}
                  className="w-full border border-gray-300 px-2 py-1 text-[11px]"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={handleCreateTest}
                    disabled={busy || !testBody.trim()}
                    className="flex-1 bg-gray-900 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    作成
                  </button>
                  <button type="button" onClick={() => setShowTestForm(false)} className="border border-gray-300 px-2 py-1 text-[11px] text-gray-600">
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 詳細(§44)。モバイルでは一覧を見ている間`hidden`にする(§78)。 */}
      <div className={`min-h-0 flex-1 overflow-y-auto p-4 md:flex md:flex-col ${mobileView === "list" ? "hidden" : "flex"}`}>
        {!selected ? (
          <p className="text-[13px] text-gray-400">左の一覧から会話を選択してください。</p>
        ) : (
          <div className="max-w-2xl">
            {/* §78: モバイル専用の「一覧へ戻る」— デスクトップでは常に両方表示しているため不要。 */}
            <button
              type="button"
              onClick={() => setMobileView("list")}
              className="mb-2 text-[12px] text-gray-500 hover:text-gray-900 md:hidden"
            >
              ← 会話一覧へ戻る
            </button>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-[15px] font-bold text-gray-900">{selected.customerDisplayName ?? "不明な顧客"}</p>
                <p className="text-[11px] text-gray-500">
                  {CHANNEL_LABEL[selected.channel]} ・ {STATUS_LABEL[selected.status]}
                  {selected.relatedInventoryId && (
                    <>
                      {" "}
                      ・ 関連商品:{" "}
                      <a href={`/inventory/${selected.relatedInventoryId}`} className="text-blue-700 underline">
                        {selected.relatedInventoryId}
                      </a>
                    </>
                  )}
                </p>
              </div>
              {canEdit && selected.status !== "RESOLVED" && selected.status !== "ARCHIVED" && (
                <button type="button" onClick={handleResolve} disabled={busy} className="border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50">
                  解決済みにする
                </button>
              )}
            </div>

            {/* timeline */}
            <div className="mb-4 space-y-2">
              {messagesLoading && <p className="text-[12px] text-gray-400">読み込み中…</p>}
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[80%] rounded p-2 text-[13px] ${m.direction === "INBOUND" ? "bg-gray-100" : "ml-auto bg-blue-50"}`}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 text-[10px] text-gray-400">
                    {m.direction === "INBOUND" ? "受信" : "送信"}
                    {m.aiGenerated && "（AI生成）"} ・{" "}
                    {{ RECEIVED: "受信済み", DRAFT: "下書き", SENDING: "送信中…", SENT: "送信済み", FAILED: "送信失敗" }[m.deliveryStatus]}
                  </p>
                </div>
              ))}
            </div>

            {/* §45: AI draft ↓ human edits ↓ send click ↓ confirmation ↓ external send。AI生成はここの「AIで返信案を生成」ボタン経由のみ(§89: 明示操作なしにAI requestしない)。 */}
            {canEdit && (
              <div className="border border-gray-200 p-3">
                <p className="mb-1 text-[11px] font-bold text-gray-500">返信</p>
                {draftMessage ? (
                  <div>
                    <p className="whitespace-pre-wrap text-[13px] text-gray-700">{draftMessage.body}</p>
                    {draftMessage.aiGenerated && <p className="mt-1 text-[10px] text-gray-400">（AI生成の下書き）</p>}
                    <button
                      type="button"
                      onClick={() => setConfirmingMessageId(draftMessage.id)}
                      disabled={busy}
                      className="mt-2 bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
                    >
                      送信する
                    </button>
                  </div>
                ) : (
                  <div>
                    <textarea
                      value={replyBody}
                      onChange={(e) => {
                        setReplyBody(e.target.value);
                        setIsAiDraft(false); // 人力で編集した時点でAI生成フラグは外す(§134: 最終本文がAI生成そのままか人力編集済みかを区別する)
                      }}
                      rows={4}
                      placeholder="返信内容を入力"
                      className="w-full border border-gray-300 px-2 py-1 text-[13px]"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        disabled={busy || !replyBody.trim()}
                        className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
                      >
                        下書きを保存
                      </button>
                      <button
                        type="button"
                        onClick={handleGenerateReply}
                        disabled={aiBusy}
                        className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {aiBusy ? "生成中…" : "AIで返信案を生成"}
                      </button>
                      {isAiDraft && <span className="text-[10px] text-gray-400">AI生成（未編集）</span>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
          </div>
        )}
      </div>

      {/* §46: 送信前最終確認モーダル。 */}
      {confirmingMessageId && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-sm border border-gray-300 bg-white p-4 shadow-lg">
            <p className="mb-3 text-[13px] font-bold text-gray-900">この内容で送信してもよろしいですか？</p>
            <dl className="mb-3 text-[12px] text-gray-700">
              <dt className="text-gray-500">チャネル</dt>
              <dd className="mb-1">{CHANNEL_LABEL[selected.channel]}</dd>
              <dt className="text-gray-500">相手</dt>
              <dd className="mb-1">{selected.customerDisplayName ?? "不明な顧客"}</dd>
              <dt className="text-gray-500">本文</dt>
              <dd className="whitespace-pre-wrap">{messages.find((m) => m.id === confirmingMessageId)?.body}</dd>
            </dl>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmSend(confirmingMessageId)}
                className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "送信中…" : "送信する"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingMessageId(null)}
                className="border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
