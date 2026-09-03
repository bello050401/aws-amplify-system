"use client";

import { useState } from "react";
import type { ConversationRecord } from "@/lib/messaging/types";
import type { ReplyRuleRecord } from "@/lib/inquiry/replyRuleSelection";
import type { NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import type { NotifyBotStatus } from "@/app/actions/lineNotify";
import type { GmailStatus } from "@/app/actions/mercariMail";
import { MessagesInbox } from "./MessagesInbox";
import { LineNotifyBotPanel } from "./LineNotifyBotPanel";
import { ReplyRulesPanel } from "./ReplyRulesPanel";
import { AiProcessingLogPanel } from "./AiProcessingLogPanel";
import { MercariMailPanel } from "./MercariMailPanel";
import { KnowledgeSettingsPanel } from "../settings/KnowledgeSettingsPanel";

/**
 * 2026-09-03 指示書 §5: メッセージ画面のセクション。
 *
 * ── 旧チャットUIを消さない ──────────────────────────────────────
 *
 * §30が「いきなり物理削除しない」「UIとして不要とバックエンドとして不要を
 * 混同しない」と明示している。加えて実務上の理由がある: 問い合わせ一覧
 * (MessagesInbox)には**対象商品カードとAI返信パネル**が乗っていて、
 * 「なぜこの返信案になったか」を確認できる唯一の画面。ここを消すと、
 * LINEに届いた提案の根拠を追う手段が無くなる。
 *
 * そこで旧一覧は「問い合わせ」タブとして残し、指示書§5が求める4セクション
 * (LINE Bot / 返信ルール / ナレッジ / AI処理ログ)を足す。既定で開くのは
 * 問い合わせ —— 日々いちばん多く使うのはここなので。
 *
 * ── ナレッジは既存パネルをそのまま使う ──────────────────────────
 *
 * 設定画面の KnowledgeSettingsPanel は props を取らず自分でデータを読む
 * ので、そのまま置ける。同じ機能を2つ実装すると、片方だけ直す事故が起きる。
 */

type TabKey = "inbox" | "linebot" | "mail" | "rules" | "knowledge" | "logs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "inbox", label: "問い合わせ" },
  { key: "linebot", label: "LINE Bot" },
  { key: "mail", label: "メール取込" },
  { key: "rules", label: "返信ルール" },
  { key: "knowledge", label: "ナレッジ" },
  { key: "logs", label: "AI処理ログ" },
];

export function MessagesCenter({
  conversations,
  canEdit,
  isAdmin,
  notifyStatus,
  gmailStatus,
  replyRules,
  deliveries,
}: {
  conversations: ConversationRecord[];
  canEdit: boolean;
  isAdmin: boolean;
  notifyStatus: NotifyBotStatus | null;
  gmailStatus: GmailStatus | null;
  replyRules: ReplyRuleRecord[];
  deliveries: NotificationDeliveryRecord[];
}) {
  const [tab, setTab] = useState<TabKey>("inbox");

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
        {/* 問い合わせ一覧だけは自前でスクロール領域を持つので、ラッパを挟まない。 */}
        {tab === "inbox" && (
          <div className="h-full">
            <MessagesInbox initialConversations={conversations} canEdit={canEdit} isAdmin={isAdmin} />
          </div>
        )}
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
