"use client";

import { useRouter } from "next/navigation";
import { signOut } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import type { InventoryRole } from "@/lib/amplify/requireInventoryUser";

const ROLE_LABEL: Record<InventoryRole, string> = {
  ADMIN: "管理者 (ADMIN)",
  EDITOR: "編集者 (EDITOR)",
  VIEWER: "閲覧のみ (VIEWER)",
};

/**
 * The one shared header row for every /inventory/* page (spec O/P/Q —
 * previously two separate, misaligned pieces: InventoryTopBar (role/
 * logout, in the shared layout) stacked above InventoryToolbar
 * (在庫一覧/検索/詳細検索/新規登録, list-page-only content), each with
 * its own border-b at a different Y. This component IS both of those
 * now, merged into one row: `center` is whatever page-specific controls
 * that page wants there (InventoryToolbar on the list page; nothing on
 * detail/new/edit/settings), role/logout are always the fixed right-hand
 * content. ONE border-b, at the bottom of this row.
 *
 * Height is `--inventory-header-height` (app/globals.css), the exact
 * same token InventoryNavRail's logo block uses — that's the entire
 * mechanism behind "the logo's bottom border and this row's bottom
 * border land on the same Y": both are literally the same fixed height,
 * not independently-tuned margins that happen to match today and drift
 * apart the next time either one's content changes.
 *
 * Rendered per-page (not once in the shared layout) specifically so each
 * page can supply its own `center` content — Next.js layouts don't have
 * a way for a page to inject content into a parent layout's specific
 * slot without parallel routes, which would be real complexity for no
 * benefit here; a one-line `<InventoryHeader role={role} center={...} />`
 * at the top of each page is simpler and just as consistent, since the
 * component itself is the single source of the shared look.
 */
export function InventoryHeader({ role, center }: { role: InventoryRole; center?: React.ReactNode }) {
  const router = useRouter();

  return (
    // 第六ラウンド§17-18(P0-4)で実機発見・修正: `h-[var(--inventory-
    // header-height)]`(固定96px)+ `overflow-x-auto`の組み合わせは、
    // 390px幅では中身(タイトル+検索+新規登録+直接編集+インポート+
    // エクスポート)が到底収まらず、はみ出た分が横スクロール可能な
    // だけの領域に押し込まれ、かつ固定高さのせいで折り返した文字が
    // 上下に見切れていた(実機スクリーンショット相当のPlaywright
    // 計測で確認済み——overflow=0のE2Eだけでは検出できない種類の不具合、
    // 詳細はdocs参照)。モバイルでは高さを内容に応じて可変にし
    // (`h-auto`)、`overflow-x-auto`ではなく`flex-wrap`で複数行に
    // 折り返させる——デスクトップ(`md:`)は既存の固定高さ・横スクロール
    // のまま変更しない。
    <div className="flex h-auto min-h-[52px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2 md:h-[var(--inventory-header-height)] md:flex-nowrap md:gap-4 md:py-0">
      <ConfigureAmplifyClientSide />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 md:flex-nowrap md:overflow-x-auto">{center}</div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-gray-500 md:gap-4">
        {/* モバイルはロールの説明文言を省略し、コンパクトに(§155)。 */}
        <span className="hidden md:inline">{ROLE_LABEL[role]}</span>
        <span className="md:hidden">{role}</span>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.push("/inventory/login");
          }}
          className="text-gray-500 hover:text-gray-900"
        >
          ログアウト
        </button>
      </div>
    </div>
  );
}
