"use client";

import { usePathname } from "next/navigation";
import { BelloLogo } from "./BelloLogo";
import { useUnsavedChanges } from "./UnsavedChangesProvider";

/**
 * Thin fixed icon rail (spec §18) — the left-most of the three layers
 * (rail → filter sidebar → main area, spec §17). 在庫一覧 and 設定 are
 * wired up; ツール stays a placeholder for genuinely near-term BELLO work.
 * 入庫/出庫/棚卸/受注管理/発注管理 were deliberately removed rather than
 * kept as placeholders — BELLO doesn't use them, and this system is meant
 * to stay a focused "登録する→探す→見る→編集する" tool, not grow
 * ERP/WMS-shaped scaffolding nobody's asked for. Re-adding any of them
 * later is a one-line change here, not a structural one. A disabled item
 * has no href and a title tooltip explaining why, rather than a dead link.
 *
 * A Client Component (not the plain Server Component it used to be)
 * because "which item is current" now needs the actual route
 * (usePathname) — /inventory/settings is a sibling of /inventory itself
 * under the same shared (protected) layout, so a single hardcoded
 * `current="inventory"` passed down from that layout could never tell
 * the two apart.
 */
// BELLO統合業務OS指示書(2026-08-30) §70-72: MobileBottomNav.tsx(モバイル
// 用ボトムナビ)と共有する — 「在庫一覧/売上/EC出品/メッセージ/設定」の
// 並び順・href・enabledはデスクトップ用rail/モバイル用bottom navで
// 絶対に食い違ってはいけない一次情報なので、1箇所にのみ定義する。
export const NAV_ITEMS = [
  { key: "inventory", label: "在庫一覧", href: "/inventory", enabled: true },
  // 夜間開発指示書 §12: 在庫一覧/売上/設定という主要構成。
  { key: "sales", label: "売上", href: "/inventory/sales", enabled: true },
  // BELLO統合改修 master指示書(2026-08-29統合改修版) §14: 「EC出品」を
  // 売上の直下へ追加 — 在庫詳細画面の既存「EC出品」リンク
  // (/inventory/[id]/listing、1商品単位)はこの変更後も残したまま
  // (Q4/Q12/Q13で明示的に要求されている)、こちらは横断的な一覧
  // ベースの管理画面(/inventory/listings、app/inventory/(protected)/
  // listings/page.tsx)への入口。
  { key: "listings", label: "EC出品", href: "/inventory/listings", enabled: true },
  // BELLO統合業務OS指示書(2026-08-30) §38: 「メッセージ」をEC出品の
  // 直下へ追加。
  { key: "messages", label: "メッセージ", href: "/inventory/messages", enabled: true },
  { key: "tools", label: "ツール", href: null, enabled: false },
  { key: "settings", label: "設定", href: "/inventory/settings", enabled: true },
] as const;

/**
 * §70/§122: モバイル幅では「常設のデスクトップサイドバー」を残さない
 * — このrail自体は`md:flex`以上でのみ表示し、390px等の狭幅では
 * `hidden`にする(代わりにMobileBottomNav.tsxが表示される、
 * ProtectedInventoryLayout側で両方をレンダーしCSSで出し分ける)。
 */
export function InventoryNavRail() {
  const pathname = usePathname();
  const { guardedNavigate } = useUnsavedChanges();

  return (
    // No border-r on this outer element — the vertical nav-rail divider
    // starts below the header row (on the <ul> below), never alongside
    // the logo. A border-r running the full height here would cross the
    // header's own border-b right at the logo's corner, producing the
    // "十字に罫線が交差する" look the header redesign explicitly avoids
    // (see InventoryHeader.tsx's file comment for the full picture).
    <nav className="hidden w-16 shrink-0 flex-col bg-white md:flex">
      {/* Brand area — the icon itself already carries the "BELLO SYSTEM"
          wordmark, so it's the whole brand mark here now, not an icon
          plus a separate redundant "BELLO" label beside it. `overflow-hidden`
          guards against an unusually wide real logo file — the rail itself
          stays exactly `w-16` no matter what: if the real file's aspect
          ratio would render wider than that at 72px tall, it's cropped
          right here rather than widening the rail or shifting the nav
          items below.
          Height is the shared --inventory-header-height token, not
          padding-driven auto height — this is what lets this block's
          bottom border land on exactly the same Y as InventoryHeader's
          own border-b elsewhere in the row (see that file's comment);
          the value itself is unchanged from what this block always
          rendered at (72px logo + existing py-3 padding), so the logo's
          own size/position is not affected. */}
      {/* H/I: ロゴ = 在庫一覧へのホーム導線。未保存変更ガード
          (UnsavedChangesProvider) を経由するbuttonであって、素の
          <Link>ではない — dirtyな新規登録/編集フォームを開いたまま
          クリックしても、確認なしに変更を失わないようにするため。 */}
      <button
        type="button"
        onClick={() => guardedNavigate("/inventory")}
        className="flex h-[var(--inventory-header-height)] items-center justify-center overflow-hidden border-b border-gray-200 px-2"
        title="在庫一覧へ戻る"
      >
        <BelloLogo variant="sidebar" />
      </button>
      <ul className="flex flex-1 flex-col border-r border-gray-200 py-1">
        {NAV_ITEMS.map((item) => {
          // /inventory itself must not read as "current" for every
          // /inventory/* route (it would otherwise match /inventory/settings
          // too, via a naive prefix check) — it's current only on an exact
          // match; 設定 is current for /inventory/settings and anything
          // nested under it.
          const isCurrent = item.href != null && (item.href === "/inventory" ? pathname === "/inventory" : pathname?.startsWith(item.href));
          // 統合改善指示書 §10: 10px は他の一覧UI(検索/サイドバーの保
          // 管場所・カテゴリ等、多くがtext-[12px]/[13px])と比べて明ら
          // かに小さく見えていた — w-16の密度を崩さない範囲で11pxへ。
          const className = [
            "flex flex-col items-center gap-0.5 px-1 py-2.5 text-center text-[11px] leading-tight",
            isCurrent
              ? "border-l-2 border-gray-900 bg-gray-100 font-bold text-gray-900"
              : item.enabled
                ? "border-l-2 border-transparent text-gray-600 hover:bg-gray-50"
                : "border-l-2 border-transparent text-gray-300",
          ].join(" ");

          if (!item.href) {
            return (
              <li key={item.key} className={className} title="今後のPhaseで実装予定">
                {item.label}
              </li>
            );
          }
          const href = item.href;
          return (
            <li key={item.key}>
              <button type="button" onClick={() => guardedNavigate(href)} className={`w-full ${className}`}>
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
