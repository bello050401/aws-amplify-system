"use client";

import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { useEffect, useState } from "react";
import {
  createTestConversationAction,
  draftReplyAction,
  listRecentMessagesAction,
  sendReplyAction,
} from "@/app/actions/messaging";
import { politenessRewriteAction } from "@/app/actions/inquiryReply";
import {
  markConversationReadAction,
  setConversationWorkflowStatusAction,
  deleteConversationAction,
} from "@/app/actions/messaging";
import {
  CONVERSATION_FILTERS,
  CONVERSATION_FILTER_LABEL,
  DEFAULT_CONVERSATION_FILTER,
  SELECTABLE_WORKFLOW_STATUSES,
  WORKFLOW_STATUS_LABEL,
  type ConversationFilter,
  type ConversationWorkflowStatus,
} from "@/lib/messaging/types";
import { listCompletedConversationsAction, setConversationCompletedAction } from "@/app/actions/messaging";
import { getLineOutboundStatusAction } from "@/app/actions/messaging";
import { MESSAGE_PAGE_SIZE } from "@/lib/messaging/messagePaging";
import { AiReplyPanel } from "./AiReplyPanel";
import { MessageAttachment } from "./MessageAttachment";
import type { ConversationRecord, MessageRecord } from "@/lib/messaging/types";

/**
 * 2026-09-02 指示書§2/§4/§7 のフィルタ再設計。
 *
 *   未返信 ｜ 返信済み ｜ すべて ｜ 大原確認 ｜ 市川確認 ｜ 対応済み
 *
 * 「未読」と「要返信」は廃止して「未返信」へ一本化した。業務の判断は
 * 「読んだか」ではなく「返信したか」で行う —— 人が画面で会話を開いた
 * だけで対応対象から消えてはいけない。read/unread はDBに残してあり、
 * 新着の視覚的な目印としてだけ使う。
 *
 * 「解決済み」は廃止して「対応済み」へ。返信済み ≠ 対応済み で、
 * 配送予定日を回答済みでも配送前なら返信済みであって対応済みではない。
 *
 * 並び順は lib/messaging/types.ts の CONVERSATION_FILTERS が正本。
 */
const FILTER_ORDER = CONVERSATION_FILTERS;

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
  // 初期表示は「未返信」(指示書§3)。日常業務で最優先なのは
  // まだ返信していない問い合わせなので、開いた瞬間に対応対象が見える。
  const [filter, setFilter] = useState<ConversationFilter>(DEFAULT_CONVERSATION_FILTER);
  // 対応済みは通常の取得から外してある(サーバー側で除外)。タブを
  // 押したときにだけ取りに行く。
  const [completedConversations, setCompletedConversations] = useState<ConversationRecord[] | null>(null);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedError, setCompletedError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversations[0]?.id ?? null);
  // BELLO統合業務OS指示書(2026-08-30) §70/§78: モバイル幅では一覧と
  // 詳細を横並びにする余地が無い(w-72の一覧だけで390pxの大半を占めて
  // しまう) — selectedIdとは独立に「今どちらの画面を見せるか」を持つ。
  // デスクトップ(`md:`以上)ではこの値を無視して常に両方表示する。
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);
  // LINEへの実送信が有効かどうか。サーバー側の feature flag が正本で、
  // ここはその表示用(UIをdisabledにするのは補助であって防御ではない)。
  const [lineOutbound, setLineOutbound] = useState<{ enabled: boolean; message: string } | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingMessageId, setConfirmingMessageId] = useState<string | null>(null);
  const [showTestForm, setShowTestForm] = useState(false);
  const [testCustomer, setTestCustomer] = useState("");
  const [testBody, setTestBody] = useState("");
  const [isAiDraft, setIsAiDraft] = useState(false);
  // 「敬語に整える」の状態。整える前の文章は戻せるように取っておく
  // ——整えた結果が気に入らないときに、書き直しをやり直させない。
  const [keigoBusy, setKeigoBusy] = useState(false);
  const [keigoNotes, setKeigoNotes] = useState<string[]>([]);
  const [keigoBefore, setKeigoBefore] = useState<string | null>(null);

  // 「未返信」は needsReply(= 最新の受信より後にBELLOから返信して
  // いない)で判定する。unreadCount では判定しない —— 人が開いただけで
  // 消えてしまい、対応漏れの温床になる。
  const activeList = filter === "COMPLETED" ? (completedConversations ?? []) : conversations;
  const filtered = activeList.filter((c) => {
    if (filter === "UNREPLIED") return c.needsReply;
    if (filter === "REPLIED") return !c.needsReply;
    if (filter === "OHARA_REVIEW") return c.workflowStatus === "OHARA_REVIEW";
    if (filter === "ICHIKAWA_REVIEW") return c.workflowStatus === "ICHIKAWA_REVIEW";
    // ALL = 現在対応中の全会話。対応済みはサーバー側で既に除外されている。
    // COMPLETED = 対応済みだけ(別途取得したリスト)。
    return true;
  });
  const selected = [...conversations, ...(completedConversations ?? [])].find((c) => c.id === selectedId) ?? null;
  // LINEの会話で、かつ送信が無効なとき。TEST会話はBELLO内で完結する
  // ので止めない(実顧客へは届かない)。
  const outboundBlocked = selected?.channel === "LINE" && lineOutbound?.enabled !== true;

  // 「対応済み」タブを押したときにだけ取りに行く(指示書§14)。
  useEffect(() => {
    if (filter !== "COMPLETED" || completedConversations !== null || completedLoading) return;
    setCompletedLoading(true);
    setCompletedError(null);
    listCompletedConversationsAction()
      .then(setCompletedConversations)
      .catch((err) => setCompletedError(err instanceof Error ? err.message : "対応済みの会話を取得できませんでした。"))
      .finally(() => setCompletedLoading(false));
  }, [filter, completedConversations, completedLoading]);

  /**
   * 会話を開いたときは**最新50件だけ**読む(指示書§16)。
   *
   * 会話が長く続けばMessageは際限なく増える。最初から全件読むと、
   * 古い会話ほど開くのが遅くなる。続きは「過去のメッセージを読み込む」
   * で明示的に取る。
   */
  async function loadMessages(conversationId: string, limit = MESSAGE_PAGE_SIZE) {
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const page = await listRecentMessagesAction(conversationId, limit);
      setMessages(page.messages);
      setHasOlderMessages(page.hasOlder);
      setTotalMessageCount(page.totalCount);
      setMessageLimit(limit);
    } catch (err) {
      // 会話そのものは開けている。ここだけを局所的に失敗させる(§33)。
      setMessagesError(err instanceof Error ? err.message : "メッセージを読み込めませんでした。");
    } finally {
      setMessagesLoading(false);
    }
  }

  // LINE送信が有効かどうかをサーバーへ確認する。会話を開くたびではなく
  // 画面のマウント時に1回だけ(設定値なので会話ごとに変わらない)。
  useEffect(() => {
    let cancelled = false;
    getLineOutboundStatusAction()
      .then((s) => {
        if (!cancelled) setLineOutbound(s);
      })
      .catch(() => {
        // 取得できなかったときは**送信できない側**へ倒す。
        if (!cancelled) setLineOutbound({ enabled: false, message: "送信可否を確認できなかったため、送信を無効にしています。" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadOlderMessages() {
    if (!selectedId) return;
    await loadMessages(selectedId, messageLimit + MESSAGE_PAGE_SIZE);
  }

  useEffect(() => {
    if (selectedId) {
      void loadMessages(selectedId);
      // 【ここが唯一の既読化の入口】人が会話を開いたという操作そのもの。
      // 一覧の描画やAI生成では呼ばない(サーバー側 markConversationRead の
      // コメント参照)。失敗しても会話の閲覧は妨げない。
      void markConversationReadAction(selectedId)
        .then(() => {
          setConversations((prev) =>
            prev.map((c) => (c.id === selectedId ? { ...c, isUnread: false, unreadCount: 0 } : c)),
          );
        })
        .catch((err) => console.error("[messages] 既読にできませんでした:", err));
    } else {
      setMessages([]);
    }
    setReplyBody("");
    setIsAiDraft(false);
    setConfirmingMessageId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function handleChangeWorkflowStatus(status: ConversationWorkflowStatus) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await setConversationWorkflowStatusAction(selected.id, status);
      setConversations((prev) => prev.map((c) => (c.id === selected.id ? { ...c, workflowStatus: status } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "ステータスを変更できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteConversation() {
    if (!selected) return;
    // 誤操作で即時に消えないよう、必ず確認を挟む(§3)。
    if (!window.confirm("本当に削除してもよろしいでしょうか？")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteConversationAction(selected.id);
      setConversations((prev) => prev.filter((c) => c.id !== selected.id));
      setSelectedId(null);
      setMobileView("list");
    } catch (err) {
      setError(err instanceof Error ? err.message : "会話を削除できませんでした。");
    } finally {
      setBusy(false);
    }
  }

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
   * external send。返信案の生成そのものはAiReplyPanelが担当し、ここは
   * 「反映された文章を受け取る」だけ —— 生成と送信を同じボタンに
   * まとめない(§14「AI生成と送信を一体化しない」)。
   */
  function handleApplyAiDraft(text: string) {
    setReplyBody(text);
    setIsAiDraft(true);
  }

  /**
   * §4.2/§6 スタッフが書いた内容を、意味を変えずに敬語へ整える。
   *
   * この経路は商品検索もWeb検索も配送DBも通らない（サーバー側の
   * politenessRewriteAction のコメント参照）。スタッフが既に答えを
   * 決めている場面なので、調べ直す理由がない。
   */
  async function handleKeigo() {
    if (!selected || !replyBody.trim()) return;
    setKeigoBusy(true);
    setError(null);
    setKeigoNotes([]);
    try {
      const result = await politenessRewriteAction(selected.id, replyBody);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const data = result.data;
      if (!data.ok || !data.text) {
        // 事実が変わっていたら採用しない。何が起きたかは担当者に見せる。
        setError(data.failureReason ?? "敬語への変換結果を採用できませんでした。");
        setKeigoNotes(data.ambiguityNotes);
        return;
      }
      setKeigoBefore(replyBody);
      setReplyBody(data.text);
      setIsAiDraft(false); // 事実はスタッフの原文のまま。AI生成の下書きとは別物。
      setKeigoNotes(data.ambiguityNotes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "敬語への変換に失敗しました。");
    } finally {
      setKeigoBusy(false);
    }
  }

  function handleUndoKeigo() {
    if (keigoBefore === null) return;
    setReplyBody(keigoBefore);
    setKeigoBefore(null);
    setKeigoNotes([]);
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

  /**
   * 「対応済みにする」/「対応済みを解除」(指示書§11/§12)。
   *
   * archive 的な業務状態であって削除ではない —— Message も画像も残る。
   * 対応済みにした会話は通常の一覧(未返信/返信済み/すべて)から外れ、
   * 「対応済み」タブから参照できる。
   */
  async function handleSetCompleted(completed: boolean) {
    if (!selected) return;
    if (completed) {
      const ok = window.confirm(
        "この会話を「対応済み」にしますか？\n対応済みの会話は通常の未返信・返信済み一覧から外れます。\n（会話や画像は削除されません）",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await setConversationCompletedAction(selected.id, completed);
      if (completed) {
        // 通常一覧からは外す。対応済みタブは次に開いたときに取り直す。
        setConversations((prev) => prev.filter((c) => c.id !== selected.id));
        setCompletedConversations(null);
        setSelectedId(null);
        setMobileView("list");
      } else {
        setCompletedConversations(null);
        setConversations((prev) =>
          prev.some((c) => c.id === selected.id)
            ? prev.map((c) => (c.id === selected.id ? { ...c, workflowStatus: "NEW" as const, completedAt: null } : c))
            : [{ ...selected, workflowStatus: "NEW" as const, completedAt: null }, ...prev],
        );
      }
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
          {FILTER_ORDER.map((f) => (
            <button
              key={f}
              type="button"
              data-filter={f}
              onClick={() => setFilter(f)}
              // 実測45x21 — 6つが横に並ぶので、モバイルでは押し分けに
              // 高さが要る。文字サイズは据え置きで高さだけ32pxへ。
              className={`inline-flex min-h-8 items-center whitespace-nowrap px-1.5 py-0.5 ${filter === f ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}
            >
              {CONVERSATION_FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filter === "COMPLETED" && completedLoading && (
            <p className="p-4 text-center text-[12px] text-gray-400">対応済みの会話を読み込んでいます…</p>
          )}
          {filter === "COMPLETED" && completedError && (
            <div className="m-2 border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
              <p>{completedError}</p>
              <button
                type="button"
                onClick={() => setCompletedConversations(null)}
                className="mt-1 border border-amber-400 px-2 py-0.5"
              >
                再試行
              </button>
            </div>
          )}
          {filtered.length === 0 && !completedLoading && (
            <p className="p-4 text-center text-[12px] text-gray-400">
              {filter === "UNREPLIED" ? "未返信の会話はありません。" : "会話がありません。"}
            </p>
          )}
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
                {/* どのチャネルから届いたかを必ず出す(§2)。 */}
                <span className="rounded border border-gray-200 px-1 text-[10px] text-gray-500">{CHANNEL_LABEL[c.channel]}</span>
                <span className="flex items-center gap-1">
                  {/* 業務判断は「未返信」で行う。未読は新着の目印としてだけ
                      小さく出す —— 利用者に2つを混同させない(指示書§23)。 */}
                  {c.needsReply && <span className="rounded bg-red-600 px-1 text-[10px] font-bold text-white">未返信</span>}
                  {c.isUnread && <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-label="新着" title="新着" />}
                </span>
              </div>
              <p className={`truncate text-[13px] text-gray-900 ${c.isUnread ? "font-bold" : ""}`}>
                {c.customerDisplayName ?? "不明な顧客"}
              </p>
              <p className="truncate text-[12px] text-gray-500">
                {c.lastMessagePreview ?? "（本文なし）"}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-gray-400">
                <span className="rounded bg-gray-100 px-1 text-gray-600">{WORKFLOW_STATUS_LABEL[c.workflowStatus]}</span>
                <span>{c.lastMessageAt ? formatJstDateTime(c.lastMessageAt) : ""}</span>
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
              <div className="flex items-center gap-2">
                {/* 対応済みは archive 的な業務状態であって削除ではない。
                    Message も画像も一切消さない(指示書§29)。
                    誤操作と再問い合わせのために解除もできる(§12)。 */}
                {canEdit &&
                  (selected.workflowStatus === "COMPLETED" ? (
                    <button
                      type="button"
                      onClick={() => void handleSetCompleted(false)}
                      disabled={busy}
                      className="border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      対応済みを解除
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSetCompleted(true)}
                      disabled={busy}
                      className="border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      対応済みにする
                    </button>
                  ))}
                {isAdmin && (
                  <button
                    type="button"
                    onClick={handleDeleteConversation}
                    disabled={busy}
                    className="border border-red-300 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    会話を削除
                  </button>
                )}
              </div>
            </div>

            {/* 返信状態と業務ステータスを別の行に分ける(指示書§24)。

                返信状態は「最新の受信より後にBELLOから返信したか」という
                事実で、人がボタンで切り替えるものではない。だから表示だけ。
                業務ステータスは人が指定するもので、返信状態とは独立に持つ
                —— 「大原確認」中でも「まだ返信していない」事実は消えない。 */}
            <div className="mb-3 space-y-1 border border-gray-200 bg-gray-50 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-gray-500">返信状態:</span>
                <span
                  className={`px-2 py-0.5 text-[11px] font-bold ${
                    selected.needsReply ? "bg-red-600 text-white" : "bg-gray-200 text-gray-700"
                  }`}
                >
                  {selected.needsReply ? "未返信" : "返信済み"}
                </span>
                <span className="text-[10px] text-gray-400">
                  お客様へ実際に送信されたときだけ「返信済み」になります（AI案の作成・下書き保存では変わりません）。
                </span>
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-[11px] text-gray-500">業務ステータス:</span>
                  {SELECTABLE_WORKFLOW_STATUSES.map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => void handleChangeWorkflowStatus(st)}
                      disabled={busy}
                      className={`border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                        selected.workflowStatus === st
                          ? "border-gray-900 bg-gray-900 font-bold text-white"
                          : "border-gray-300 text-gray-600 hover:bg-white"
                      }`}
                    >
                      {WORKFLOW_STATUS_LABEL[st]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void handleChangeWorkflowStatus("NEW")}
                    disabled={busy}
                    className={`border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                      selected.workflowStatus === "NEW" || selected.workflowStatus === "REPLIED"
                        ? "border-gray-900 bg-gray-900 font-bold text-white"
                        : "border-gray-300 text-gray-600 hover:bg-white"
                    }`}
                  >
                    確認指定なし
                  </button>
                </div>
              )}
            </div>

            {/* timeline */}
            <div className="mb-4 space-y-2">
              {messagesLoading && <p className="text-[12px] text-gray-400">読み込み中…</p>}
              {messagesError && (
                <div className="border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
                  <p>{messagesError}</p>
                  <button
                    type="button"
                    onClick={() => selectedId && void loadMessages(selectedId, messageLimit)}
                    className="mt-1 border border-amber-400 px-2 py-0.5"
                  >
                    再読み込み
                  </button>
                </div>
              )}
              {hasOlderMessages && !messagesLoading && (
                <button
                  type="button"
                  onClick={() => void loadOlderMessages()}
                  className="mx-auto block border border-gray-300 px-3 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                >
                  過去のメッセージを読み込む（表示 {messages.length} / 全 {totalMessageCount} 件）
                </button>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[80%] rounded p-2 text-[13px] ${m.direction === "INBOUND" ? "bg-gray-100" : "ml-auto bg-blue-50"}`}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {/* 受信画像。BELLO側S3へ保存済みのものだけを出す ——
                      LINEのURLは期限切れするので直接は参照しない。 */}
                  {m.attachmentStatus === "STORED" && m.attachmentStorageKey && (
                    <MessageAttachment storageKey={m.attachmentStorageKey} contentType={m.attachmentContentType} />
                  )}
                  {/* 取得に失敗しても会話は残る。何が起きたかを担当者に見せる。 */}
                  {m.attachmentStatus === "FAILED" && (
                    <p className="mt-1 border border-amber-300 bg-amber-50 p-1 text-[11px] text-amber-800">
                      画像を取得できませんでした{m.attachmentError ? `: ${m.attachmentError}` : ""}
                    </p>
                  )}
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
                      disabled={busy || outboundBlocked}
                      className="mt-2 bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
                    >
                      送信する
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="mb-3">
                      <AiReplyPanel conversationId={selected.id} onApplyToReply={handleApplyAiDraft} />
                    </div>
                    {/* 2026-09-02 指示書§5: LINEへの実送信は現在テスト段階のため
                        無効。UIをdisabledにするのは補助であって防御ではない ——
                        本体の防御は lib/messaging/line/outboundGuard.ts で、
                        LINE APIへHTTPリクエストを出す唯一の場所が拒否する。 */}
                    {outboundBlocked && (
                      <p className="mb-2 border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
                        {lineOutbound?.message ?? "現在テスト中のため、LINEへの送信は無効です。"}
                        <br />
                        返信案の作成・敬語への変換・下書きの保存は通常どおり行えます。
                      </p>
                    )}
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
                        onClick={handleKeigo}
                        disabled={keigoBusy || !replyBody.trim()}
                        title="書いた内容の意味は変えずに、丁寧な言い回しへ整えます"
                        className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {keigoBusy ? "整えています…" : "敬語に整える"}
                      </button>
                      {keigoBefore !== null && (
                        <button
                          type="button"
                          onClick={handleUndoKeigo}
                          className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50"
                        >
                          元に戻す
                        </button>
                      )}
                      {isAiDraft && <span className="text-[10px] text-gray-400">AI生成（未編集）</span>}
                    </div>
                    {/* §6.3 曖昧な原文の注意。顧客には送られない、担当者向けの表示。
                        エラーではないことが分かる見出しを必ず添える —— 見出しが
                        無かったため、変換が成功していても「エラーになった」と
                        受け取られていた。 */}
                    {keigoNotes.length > 0 && (
                      <div className="mt-2 border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
                      <p className="mb-1 font-bold">担当者向けの確認事項（エラーではありません。お客様には送られません）</p>
                      <ul>
                        {keigoNotes.map((note, i) => (
                          <li key={i}>・{note}</li>
                        ))}
                      </ul>
                      </div>
                    )}
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
