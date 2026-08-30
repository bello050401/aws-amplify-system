"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./InventoryNavRail";
import { useUnsavedChanges } from "./UnsavedChangesProvider";

/**
 * BELLO統合業務OS指示書(2026-08-30) §70-72: モバイル幅(`md`未満)専用の
 * 固定ボトムナビ。InventoryNavRail.tsxと同じNAV_ITEMS/現在地判定/
 * 未保存変更ガード(guardedNavigate)ロジックを共有し、表示形だけを
 * 縦アイコンrail→横並びボトムバーへ変える(ハンバーガーメニューでは
 * なくボトムナビを選んだ理由: 主要項目が5個のみで、階層メニューを
 * 開閉する分の手間よりワンタップで切り替えられる方がBELLOの実運用
 * (スタッフが在庫一覧⇄EC出品⇄メッセージを頻繁に往復する)に合う)。
 *
 * `enabled:false`の項目(ツール)はデスクトップrailと同じく非活性表示の
 * まま残す — モバイルだけ項目数が変わると「同じアプリの別画面」に見え
 * てしまうため。
 */
export function MobileBottomNav() {
  const pathname = usePathname();
  const { guardedNavigate } = useUnsavedChanges();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="主要ナビゲーション"
    >
      {NAV_ITEMS.map((item) => {
        const isCurrent = item.href != null && (item.href === "/inventory" ? pathname === "/inventory" : pathname?.startsWith(item.href));
        const className = [
          "flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-center text-[10px] leading-tight",
          isCurrent ? "font-bold text-gray-900" : item.enabled ? "text-gray-500" : "text-gray-300",
        ].join(" ");

        if (!item.href) {
          return (
            <span key={item.key} className={className} title="今後のPhaseで実装予定">
              {item.label}
            </span>
          );
        }
        const href = item.href;
        return (
          <button key={item.key} type="button" onClick={() => guardedNavigate(href)} className={className}>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
