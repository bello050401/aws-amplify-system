"use client";

import { useState } from "react";
import type { ReplyRuleRecord } from "@/lib/inquiry/replyRuleSelection";
import type { NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import type { NotifyBotStatus } from "@/app/actions/lineNotify";
import type { GmailStatus } from "@/app/actions/mercariMail";
import { LineNotifyBotPanel } from "./LineNotifyBotPanel";
import { ReplyRulesPanel } from "./ReplyRulesPanel";
import { AiProcessingLogPanel } from "./AiProcessingLogPanel";
import { MercariMailPanel } from "./MercariMailPanel";
import { KnowledgeSettingsPanel } from "../settings/KnowledgeSettingsPanel";

/**
 * 2026-09-03 追加指示 §1/§3: メッセージ画面のセクション。
 *
 * ── 「お問い合わせ」タブを外した理由 ────────────────────────────
 *
 * 運用が「BELLO内でチャットを読んで返す」から
 *
 *   受信 → 商品特定 → 分類 → ルール/ナレッジ参照 → AI返信案
 *        → 社内LINEへ通知 → 各販売チャネル側で人が返信
 *
 * へ変わったため、会話をBELLO内で閲覧・返信するUIは目的から外れた。
 * **UIだけを外し、バックエンドは一切消していない** —— Conversation /
 * Message / 受信処理 / 商品特定 / 分類 / AI生成 / 通知は新しい経路が
 * そのまま使っている(§1の削除禁止リスト)。
 *
 * 返信案の根拠は「AI処理ログ」タブで追える。実際に送った1通目・2通目の
 * 本文と、特定した商品カードをそこに出しているので、
 * 「なぜこの提案になったか」は引き続き確認できる。
 *
 * ── ナレッジは既存パネルをそのまま使う ──────────────────────────
 *
 * 設定画面にあった KnowledgeSettingsPanel は props を取らず自分でデータを
 * 読むので、そのまま置ける。§2で設定画面側の入口は外し、ここへ一本化した
 * (機能・データ・改訂履歴・AI参照はすべて維持)。
 */

type TabKey = "linebot" | "mail" | "rules" | "knowledge" | "logs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "linebot", label: "LINE Bot" },
  { key: "mail", label: "メール取込" },
  { key: "rules", label: "返信ルール" },
  { key: "knowledge", label: "ナレッジ" },
  { key: "logs", label: "AI処理ログ" },
];

export function MessagesCenter({
  isAdmin,
  notifyStatus,
  gmailStatus,
  replyRules,
  deliveries,
}: {
  isAdmin: boolean;
  notifyStatus: NotifyBotStatus | null;
  gmailStatus: GmailStatus | null;
  replyRules: ReplyRuleRecord[];
  deliveries: NotificationDeliveryRecord[];
}) {
  const [tab, setTab] = useState<TabKey>("linebot");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-gray-300 bg-white">
        <p className="px-4 pt-3 text-[12px] text-gray-600">
          お問い合わせへの返信提案・返信ルール・AIナレッジを管理します。
        </p>
        <nav className="flex flex-wrap gap-1 px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`border-b-2 px-3 py-2 text-[13px] ${
                tab === t.key
                  ? "border-gray-800 font-bold text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t.label}
              {/* 停止中の通知は放置すると誰も気づかない。タブに件数を出す。 */}
              {t.key === "logs" && deliveries.some((d) => d.status === "DEAD_LETTER" || d.status === "FAILED") && (
                <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">
                  {deliveries.filter((d) => d.status === "DEAD_LETTER" || d.status === "FAILED").length}
                </span>
              )}
              {/* Botが未設定・通知先未登録なら、その事実を一番外側で見せる。 */}
              {t.key === "linebot" && notifyStatus && (!notifyStatus.connected || !notifyStatus.hasTarget) && (
                <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">!</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "linebot" &&
          (notifyStatus ? (
            <LineNotifyBotPanel status={notifyStatus} isAdmin={isAdmin} />
          ) : (
            <p className="p-4 text-[12px] text-gray-500">
              社内通知Botの状態を読み込めませんでした。時間をおいて再読み込みしてください。
            </p>
          ))}
        {tab === "mail" &&
          (gmailStatus ? (
            <MercariMailPanel status={gmailStatus} isAdmin={isAdmin} />
          ) : (
            <p className="p-4 text-[12px] text-gray-500">
              メール取り込みの状態を読み込めませんでした。時間をおいて再読み込みしてください。
            </p>
          ))}
        {tab === "rules" && <ReplyRulesPanel rules={replyRules} isAdmin={isAdmin} />}
        {tab === "knowledge" && (
          <div className="p-4">
            <KnowledgeSettingsPanel />
          </div>
        )}
        {tab === "logs" && <AiProcessingLogPanel deliveries={deliveries} />}
      </div>
    </div>
  );
}
