import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listConversationsAction } from "@/app/actions/messaging";
import { getNotifyBotStatusAction, listRecentDeliveriesAction, type NotifyBotStatus } from "@/app/actions/lineNotify";
import { listReplyRulesAction } from "@/app/actions/replyRules";
import { getGmailStatusAction, type GmailStatus } from "@/app/actions/mercariMail";
import type { ReplyRuleRecord } from "@/lib/inquiry/replyRuleSelection";
import type { NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import { InventoryHeader } from "../../InventoryHeader";
import { MessagesCenter } from "./MessagesCenter";

export const metadata = { title: "メッセージ | BELLO 在庫管理" };

/**
 * 2026-09-03 指示書 §3/§4/§5: 問い合わせAI管理センター。
 *
 * 左サイドバーの「メッセージ」から遷移する画面。§3が「URL変更は必要性が
 * ない限り行わない」としているので、ルートは /inventory/messages のまま
 * 中身だけを入れ替える。
 *
 * 【旧チャットUIの扱い】§30に従い削除しない。問い合わせ一覧は
 * MessagesCenter の1タブとして残る(理由は MessagesCenter.tsx のコメント)。
 *
 * 【1つの失敗で画面を落とさない】通知Bot・返信ルール・処理ログは
 * それぞれ独立した機能。片方が読めなくても他は使えるべきなので、
 * Promise.allSettled で個別に受ける —— 通知Botが未設定なだけで
 * 問い合わせ一覧まで見られなくなるのは困る。
 */
export default async function MessagesPage() {
  const role = await getInventoryRole();
  if (!role) return null;

  const [conversationsResult, notifyResult, gmailResult, rulesResult, deliveriesResult] = await Promise.allSettled([
    listConversationsAction(),
    getNotifyBotStatusAction(),
    getGmailStatusAction(),
    listReplyRulesAction(),
    listRecentDeliveriesAction(50),
  ]);

  const conversations = conversationsResult.status === "fulfilled" ? conversationsResult.value : [];
  const notifyStatus: NotifyBotStatus | null = notifyResult.status === "fulfilled" ? notifyResult.value : null;
  const gmailStatus: GmailStatus | null = gmailResult.status === "fulfilled" ? gmailResult.value : null;
  const replyRules: ReplyRuleRecord[] =
    rulesResult.status === "fulfilled" && rulesResult.value.ok ? rulesResult.value.data : [];
  const deliveries: NotificationDeliveryRecord[] =
    deliveriesResult.status === "fulfilled" ? deliveriesResult.value : [];

  // 読めなかったものはログへ残す。画面上は空で表示されるので、
  // 「0件」と「読めなかった」をサーバー側では区別できるようにしておく。
  for (const [label, result] of [
    ["会話一覧", conversationsResult],
    ["通知Bot状態", notifyResult],
    ["メール取込状態", gmailResult],
    ["返信ルール", rulesResult],
    ["通知履歴", deliveriesResult],
  ] as const) {
    if (result.status === "rejected") {
      console.error(`[messages] ${label}を読めませんでした`, result.reason instanceof Error ? result.reason.message : result.reason);
    }
  }

  const needsReplyCount = conversations.filter((c) => c.needsReply).length;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader
        role={role}
        center={
          <h1 className="text-base font-bold text-gray-900">
            メッセージ
            {needsReplyCount > 0 && (
              <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
                {needsReplyCount}
              </span>
            )}
          </h1>
        }
      />
      <MessagesCenter
        conversations={conversations}
        canEdit={canEditInventory(role)}
        isAdmin={role === "ADMIN"}
        notifyStatus={notifyStatus}
        gmailStatus={gmailStatus}
        replyRules={replyRules}
        deliveries={deliveries}
      />
    </div>
  );
}
