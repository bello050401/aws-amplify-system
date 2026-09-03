"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { retryDeliveryAction } from "@/app/actions/lineNotify";
import type { NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import { MESSAGE_CHANNEL_LABEL } from "@/lib/messaging/types";

/**
 * 2026-09-03 指示書 §24/§25: AI処理ログ。
 *
 * ── 何を正本にするか ────────────────────────────────────────────
 *
 * 「AIが何をしたか」は既に ReplyDraft(返信案・根拠・使用ナレッジ・
 * 使用ルール・モデル名)に、「通知が届いたか」は NotificationDelivery に
 * 入っている。この画面は**通知を軸に**両方を並べる —— 運用で最初に見たく
 * なるのは「届いたか / 何が止まっているか」だから。
 *
 * 個々の返信案の詳細(根拠・候補商品・対象商品カード)は問い合わせ一覧の
 * AI返信パネルが既に持っているので、ここでは重複して作らず会話へ導線を出す。
 *
 * ── 秘密情報を出さない ──────────────────────────────────────────
 *
 * §24末尾。トークン・認証情報はそもそも NotificationDelivery に入って
 * いない(errorMessage は分類済みの日本語のみ)。
 */

const STATUS_LABEL: Record<NotificationDeliveryRecord["status"], string> = {
  PENDING: "送信待ち",
  PROCESSING: "送信中",
  SENT: "送信済み",
  FAILED: "失敗（再試行対象）",
  DEAD_LETTER: "停止（要対応）",
};

const STATUS_CLASS: Record<NotificationDeliveryRecord["status"], string> = {
  PENDING: "text-gray-600",
  PROCESSING: "text-blue-700",
  SENT: "text-green-700",
  FAILED: "text-amber-700",
  DEAD_LETTER: "text-red-700",
};

const PRIORITY_LABEL: Record<string, string> = {
  NORMAL: "通常",
  ATTENTION: "要確認",
  URGENT: "至急",
  PARSE_ERROR: "解析失敗",
};

export function AiProcessingLogPanel({ deliveries }: { deliveries: NotificationDeliveryRecord[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function retry(id: string) {
    setBusy(id);
    setMessage(null);
    try {
      const res = await retryDeliveryAction(id);
      setMessage({ kind: res.success ? "success" : "error", text: res.message });
      router.refresh();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "再送に失敗しました。" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 p-4 text-[13px] text-gray-800">
      <section className="border border-gray-300 bg-white p-4">
        <h3 className="mb-1 text-[14px] font-bold text-gray-900">AI処理ログ</h3>
        <p className="text-[12px] leading-relaxed text-gray-600">
          受信した問い合わせごとの、解析結果と社内LINEへの通知結果です。
          失敗した通知は原因を直したうえで再送できます。返信案の根拠（対象商品・使用ナレッジ・候補商品）は、
          各行の「会話を開く」から問い合わせ一覧のAI返信パネルで確認できます。
        </p>
        {message && (
          <p
            className={`mt-3 border p-2 text-[12px] ${
              message.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      <section className="border border-gray-300 bg-white">
        {deliveries.length === 0 ? (
          <p className="p-4 text-[12px] text-gray-500">
            まだ処理ログがありません。問い合わせを受信すると、解析結果と通知結果がここに記録されます。
          </p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {deliveries.map((d) => (
              <li key={d.id} className="p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] text-gray-500">{formatJstDateTime(d.createdAt)}</span>
                      {d.channel && (
                        <span className="border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                          {MESSAGE_CHANNEL_LABEL[d.channel]}
                        </span>
                      )}
                      <span className={`text-[12px] font-bold ${STATUS_CLASS[d.status]}`}>{STATUS_LABEL[d.status]}</span>
                      {d.priority && d.priority !== "NORMAL" && (
                        <span className="border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                          {PRIORITY_LABEL[d.priority] ?? d.priority}
                        </span>
                      )}
                      {d.attemptCount > 0 && <span className="text-[10px] text-gray-500">試行 {d.attemptCount}回</span>}
                    </p>

                    {d.errorMessage && <p className="mt-1 text-[12px] text-red-700">{d.errorMessage}</p>}

                    {d.sentAt && <p className="mt-1 text-[11px] text-gray-500">送信 {formatJstDateTime(d.sentAt)}</p>}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                      className="border border-gray-400 bg-white px-2 py-1 text-[11px] hover:bg-gray-50"
                    >
                      {expanded === d.id ? "本文を隠す" : "送信内容"}
                    </button>
                    {d.conversationId && (
                      <a
                        href={`/inventory/messages?conversation=${encodeURIComponent(d.conversationId)}`}
                        className="border border-gray-400 bg-white px-2 py-1 text-[11px] hover:bg-gray-50"
                      >
                        会話を開く
                      </a>
                    )}
                    {/* 送信済みは再送させない。同じ通知が2回届くと、担当者は
                        新しい問い合わせが来たと読む。 */}
                    {d.status !== "SENT" && d.status !== "PROCESSING" && (
                      <button
                        type="button"
                        disabled={busy === d.id}
                        onClick={() => retry(d.id)}
                        className="border border-gray-800 bg-gray-800 px-2 py-1 text-[11px] text-white hover:bg-gray-700 disabled:opacity-50"
                      >
                        {busy === d.id ? "送信中…" : "再送"}
                      </button>
                    )}
                  </div>
                </div>

                {expanded === d.id && (
                  <div className="mt-3 space-y-2 border-t border-gray-200 pt-3">
                    <div>
                      <p className="mb-1 text-[11px] font-bold text-gray-600">1通目（問い合わせ・判断材料）</p>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-gray-200 bg-gray-50 p-2 text-[11px]">
                        {d.summaryText ?? "（本文なし）"}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-bold text-gray-600">2通目（返信提案）</p>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-gray-200 bg-gray-50 p-2 text-[11px]">
                        {d.replyText ?? "（返信案は生成されていません）"}
                      </pre>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
