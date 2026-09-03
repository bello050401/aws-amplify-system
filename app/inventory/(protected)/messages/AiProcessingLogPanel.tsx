"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { getDeliveryEvidenceAction, retryDeliveryAction } from "@/app/actions/lineNotify";
import { IdentifiedProductCardView } from "./IdentifiedProductCardView";
import type { IdentifiedProductCard } from "@/lib/inquiry/types";
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
 * 【根拠もここに出す】2026-09-03 追加指示§1で「お問い合わせ」タブを外したため、
 * 返信案の根拠を見られる画面がここだけになった。展開したときに、特定できた商品・
 * 適用したルール・参照したナレッジ・候補商品を出す(§24の監査項目)。
 * 一覧では読まない —— 50件分の根拠を毎回読むと重く、大半は開かれないため。
 *
 * ── 秘密情報を出さない ──────────────────────────────────────────
 *
 * §24末尾。トークン・認証情報はそもそも NotificationDelivery に入って
 * いない(errorMessage は分類済みの日本語のみ)。
 */

/**
 * 通知の状態(§7)。**解析の状態とは別軸**で出す。
 *
 * 以前は通知先が未登録なだけでも「停止（要対応）」と表示していたため、
 * 解析まで失敗したように見えていた。友だち追加すれば送れるものは
 * 「通知待ち」として区別する。
 */
const STATUS_LABEL: Record<NotificationDeliveryRecord["status"], string> = {
  PENDING: "通知待ち",
  PROCESSING: "送信中",
  SENT: "通知済み",
  FAILED: "通知失敗（再試行対象）",
  DEAD_LETTER: "通知停止（要対応）",
  WAITING_FOR_TARGET: "通知待ち（友だち追加待ち）",
  SUPERSEDED: "置き換え済み",
};

const STATUS_CLASS: Record<NotificationDeliveryRecord["status"], string> = {
  PENDING: "text-gray-600",
  PROCESSING: "text-blue-700",
  SENT: "text-green-700",
  FAILED: "text-amber-700",
  DEAD_LETTER: "text-red-700",
  WAITING_FOR_TARGET: "text-amber-700",
  SUPERSEDED: "text-gray-400",
};

/** 解析側の状態(§7)。通知が届いたかとは無関係。 */
const ANALYSIS_LABEL: Record<string, string> = {
  OK: "解析完了",
  NEEDS_REVIEW: "解析完了（要確認）",
  PARSE_FAILED: "本文抽出に失敗",
  GENERATION_FAILED: "返信案の生成に失敗",
};

const ANALYSIS_CLASS: Record<string, string> = {
  OK: "text-green-700",
  NEEDS_REVIEW: "text-amber-700",
  PARSE_FAILED: "text-red-700",
  GENERATION_FAILED: "text-red-700",
};

const KIND_LABEL: Record<string, string> = {
  PRODUCT_INQUIRY: "お問い合わせ",
  ORDER_MESSAGE: "取引メッセージ",
};

interface Evidence {
  identifiedProduct: IdentifiedProductCard | null;
  knowledgeDocuments: { id: string; title: string; fileName: string }[];
  appliedReplyRules: { id: string; title: string; category: string; version: number }[];
  productCandidates: { displayInventoryId: string; name: string; confidence: number }[];
  modelName: string | null;
  status: string | null;
}

const PRIORITY_LABEL: Record<string, string> = {
  NORMAL: "通常",
  ATTENTION: "要確認",
  URGENT: "至急",
  PARSE_ERROR: "解析失敗",
};

export function AiProcessingLogPanel({ deliveries }: { deliveries: NotificationDeliveryRecord[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, Evidence | null>>({});
  const [loadingEvidence, setLoadingEvidence] = useState(false);
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
          失敗した通知は原因を直したうえで再送できます。
          「詳細」を開くと、実際に送った1通目・2通目の本文と、返信案の根拠
          （特定した商品・適用したルール・参照したナレッジ・候補商品）を確認できます。
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
                      {d.inquiryKind && (
                        <span className="border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                          {KIND_LABEL[d.inquiryKind] ?? d.inquiryKind}
                        </span>
                      )}
                      {/* §7 解析と通知は別軸。並べて出し、混同させない。 */}
                      {d.analysisStatus && (
                        <span className={`text-[12px] ${ANALYSIS_CLASS[d.analysisStatus] ?? "text-gray-600"}`}>
                          解析: {ANALYSIS_LABEL[d.analysisStatus] ?? d.analysisStatus}
                        </span>
                      )}
                      <span className={`text-[12px] font-bold ${STATUS_CLASS[d.status]}`}>
                        通知: {STATUS_LABEL[d.status]}
                      </span>
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
                      onClick={async () => {
                        const next = expanded === d.id ? null : d.id;
                        setExpanded(next);
                        // 根拠は開いたときだけ読む。既に読んでいれば読み直さない。
                        if (next && d.replyDraftId && evidence[d.id] === undefined) {
                          setLoadingEvidence(true);
                          try {
                            const ev = await getDeliveryEvidenceAction(d.replyDraftId);
                            setEvidence((prev) => ({ ...prev, [d.id]: ev }));
                          } catch {
                            // 根拠が読めなくても本文は見せる。ここで失敗を投げると
                            // 「詳細が一切開かない」になり、調査の役に立たない。
                            setEvidence((prev) => ({ ...prev, [d.id]: null }));
                          } finally {
                            setLoadingEvidence(false);
                          }
                        }
                      }}
                      className="border border-gray-400 bg-white px-2 py-1 text-[11px] hover:bg-gray-50"
                    >
                      {expanded === d.id ? "詳細を隠す" : "詳細"}
                    </button>
                    {/* 送信済みは再送させない。同じ通知が2回届くと、担当者は
                        新しい問い合わせが来たと読む。 */}
                    {d.status !== "SENT" && d.status !== "PROCESSING" && d.status !== "SUPERSEDED" && (
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

                    {/* §24 監査項目。なぜこの返信案になったかを追えるようにする。 */}
                    {d.replyDraftId && (
                      <div className="space-y-2">
                        <p className="text-[11px] font-bold text-gray-600">返信案の根拠</p>
                        {loadingEvidence && evidence[d.id] === undefined ? (
                          <p className="text-[11px] text-gray-500">読み込み中…</p>
                        ) : evidence[d.id] ? (
                          <>
                            {evidence[d.id]!.identifiedProduct ? (
                              <IdentifiedProductCardView card={evidence[d.id]!.identifiedProduct!} />
                            ) : (
                              <p className="text-[11px] text-gray-500">対象商品は特定できていません。</p>
                            )}

                            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-[11px]">
                              <dt className="text-gray-500">適用ルール</dt>
                              <dd>
                                {evidence[d.id]!.appliedReplyRules.length > 0
                                  ? evidence[d.id]!.appliedReplyRules
                                      .map((r) => `${r.title}（v${r.version}）`)
                                      .join(" / ")
                                  : "なし"}
                              </dd>

                              <dt className="text-gray-500">参照ナレッジ</dt>
                              <dd>
                                {evidence[d.id]!.knowledgeDocuments.length > 0
                                  ? evidence[d.id]!.knowledgeDocuments.map((k) => k.title).join(" / ")
                                  : "なし"}
                              </dd>

                              {/* 候補が複数あったことは、誤特定を疑うときの手がかりになる。 */}
                              {evidence[d.id]!.productCandidates.length > 1 && (
                                <>
                                  <dt className="text-gray-500">候補商品</dt>
                                  <dd>
                                    {evidence[d.id]!.productCandidates
                                      .map((c) => `${c.name}（${c.confidence.toFixed(2)}）`)
                                      .join(" / ")}
                                  </dd>
                                </>
                              )}

                              {d.orderNumber && (
                          <>
                            <dt className="text-gray-500">注文番号</dt>
                            <dd className="break-all">{d.orderNumber}</dd>
                          </>
                        )}

                        <dt className="text-gray-500">モデル</dt>
                              <dd>{evidence[d.id]!.modelName ?? "—"}</dd>

                              <dt className="text-gray-500">返信案の状態</dt>
                              <dd>{evidence[d.id]!.status ?? "—"}</dd>
                            </dl>
                          </>
                        ) : (
                          <p className="text-[11px] text-gray-500">根拠を読み込めませんでした。</p>
                        )}
                      </div>
                    )}
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
