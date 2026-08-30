import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listConversationsAction } from "@/app/actions/messaging";
import { InventoryHeader } from "../../InventoryHeader";
import { MessagesInbox } from "./MessagesInbox";

export const metadata = { title: "メッセージ | BELLO 在庫管理" };

/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: 統合メッセージ受信箱。
 * 左サイドバーの「メッセージ」(EC出品の直下、InventoryNavRail.tsx
 * 参照)から遷移。
 *
 * 【現状の実装範囲、正直に】このラウンドでは実チャネル(Mercari問い
 * 合わせAPI/Yahoo!オークションストア/LINE公式アカウント/Email)の
 * どれからもメッセージを受信する経路を実装していない(§51以降=
 * Priority 6、各外部サービスの実API調査が別途必要なため) —
 * 受信箱UI・会話タイムライン・返信下書き・送信前確認・送信・
 * 「返信済み」判定ロジックの骨組みまでを実装し、ADMIN限定の
 * 「テスト会話を作成」機能で実際に一通り動作を確認できるようにして
 * いる(lib/messaging/service.tsのファイル冒頭コメント参照)。
 *
 * 権限: 閲覧・下書き・送信・解決はADMIN/EDITOR/VIEWERの既存の権限
 * モデルに合わせる(閲覧は全員、書き込みはADMIN/EDITOR) —
 * app/actions/messaging.ts参照。
 */
export default async function MessagesPage() {
  const role = await getInventoryRole();
  if (!role) return null;

  const conversations = await listConversationsAction();

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader
        role={role}
        center={
          <h1 className="text-base font-bold text-gray-900">
            メッセージ
            {conversations.filter((c) => c.needsReply).length > 0 && (
              <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
                {conversations.filter((c) => c.needsReply).length}
              </span>
            )}
          </h1>
        }
      />
      <MessagesInbox initialConversations={conversations} canEdit={canEditInventory(role)} isAdmin={role === "ADMIN"} />
    </div>
  );
}
