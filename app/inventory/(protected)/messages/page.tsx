import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getNotifyBotStatusAction, listRecentDeliveriesAction, type NotifyBotStatus } from "@/app/actions/lineNotify";
import { listReplyRulesAction } from "@/app/actions/replyRules";
import { getGmailStatusAction, type GmailStatus } from "@/app/actions/mercariMail";
import type { ReplyRuleRecord } from "@/lib/inquiry/replyRuleSelection";
import type { NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import { InventoryHeader } from "../../InventoryHeader";
import { MessagesCenter } from "./MessagesCenter";

export const metadata = { title: "メッセージ | BELLO 在庫管理" };

/**
 * 2026-09-03 指示書 §3/§4/§5 + 同日追加指示 §1/§3: 問い合わせAI管理センター。
 *
 * 左サイドバーの「メッセージ」から遷移する画面。ルートは
 * /inventory/messages のまま中身だけを入れ替える(§3「URL変更は必要性が
 * ない限り行わない」)。
 *
 * 【会話一覧を読まなくなった】追加指示§1で「お問い合わせ」タブを外したため、
 * この画面はもう Conversation を一覧しない。**モデルも受信処理も消していない** ——
 * 読む必要が無くなっただけで、Webhookは今も Conversation/Message を書いており、
 * AI処理ログはそこから作られた通知を表示する。
 *
 * 【1つの失敗で画面を落とさない】各タブは独立した機能なので
 * Promise.allSettled で個別に受ける —— 通知Botが未設定なだけで
 * 返信ルールまで見られなくなるのは困る。
 */
export default async function MessagesPage() {
  const role = await getInventoryRole();
  if (!role) return null;

  const [notifyResult, gmailResult, rulesResult, deliveriesResult] = await Promise.allSettled([
    getNotifyBotStatusAction(),
    getGmailStatusAction(),
    listReplyRulesAction(),
    listRecentDeliveriesAction(50),
  ]);

  const notifyStatus: NotifyBotStatus | null = notifyResult.status === "fulfilled" ? notifyResult.value : null;
  const gmailStatus: GmailStatus | null = gmailResult.status === "fulfilled" ? gmailResult.value : null;
  const replyRules: ReplyRuleRecord[] =
    rulesResult.status === "fulfilled" && rulesResult.value.ok ? rulesResult.value.data : [];
  const deliveries: NotificationDeliveryRecord[] =
    deliveriesResult.status === "fulfilled" ? deliveriesResult.value : [];

  // 読めなかったものはログへ残す。画面上は空で表示されるので、
  // 「0件」と「読めなかった」をサーバー側では区別できるようにしておく。
  for (const [label, result] of [
    ["通知Bot状態", notifyResult],
    ["メール取込状態", gmailResult],
    ["返信ルール", rulesResult],
    ["通知履歴", deliveriesResult],
  ] as const) {
    if (result.status === "rejected") {
      console.error(
        `[messages] ${label}を読めませんでした`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }

  // 対応が要る通知(失敗・停止)の件数。ヘッダのバッジに出す ——
  // 会話の未返信件数を出していた場所を、新しい運用に合わせて置き換える。
  const needsAttention = deliveries.filter((d) => d.status === "FAILED" || d.status === "DEAD_LETTER").length;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader
        role={role}
        center={
          <h1 className="text-base font-bold text-gray-900">
            メッセージ
            {needsAttention > 0 && (
              <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
                {needsAttention}
              </span>
            )}
          </h1>
        }
      />
      <MessagesCenter
        isAdmin={role === "ADMIN"}
        notifyStatus={notifyStatus}
        gmailStatus={gmailStatus}
        replyRules={replyRules}
        deliveries={deliveries}
      />
    </div>
  );
}
