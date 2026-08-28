"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BelloLogo } from "./BelloLogo";

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
const NAV_ITEMS = [
  { key: "inventory", label: "在庫一覧", href: "/inventory", enabled: true },
  { key: "tools", label: "ツール", href: null, enabled: false },
  { key: "settings", label: "設定", href: "/inventory/settings", enabled: true },
] as const;

export function InventoryNavRail() {
  const pathname = usePathname();

  return (
    <nav className="flex w-16 shrink-0 flex-col border-r border-gray-200 bg-white">
      {/* Brand area — the icon itself already carries the "BELLO SYSTEM"
          wordmark, so it's the whole brand mark here now, not an icon
          plus a separate redundant "BELLO" label beside it. Sized by
          padding + BelloLogo's own "sidebar" variant (72px tall) rather
          than a fixed height on this container, so it can't clip a real
          logo file whose actual proportions turn out taller than
          expected. `overflow-hidden` is the guard for the opposite risk
          — the rail itself stays exactly `w-16` no matter what: if the
          real file's aspect ratio would render wider than that at 72px
          tall, it's cropped right here rather than widening the rail or
          shifting the nav items below. */}
      <div className="flex items-center justify-center overflow-hidden border-b border-gray-200 px-2 py-3">
        <BelloLogo variant="sidebar" />
      </div>
      <ul className="flex flex-1 flex-col py-1">
        {NAV_ITEMS.map((item) => {
          // /inventory itself must not read as "current" for every
          // /inventory/* route (it would otherwise match /inventory/settings
          // too, via a naive prefix check) — it's current only on an exact
          // match; 設定 is current for /inventory/settings and anything
          // nested under it.
          const isCurrent = item.href != null && (item.href === "/inventory" ? pathname === "/inventory" : pathname?.startsWith(item.href));
          const className = [
            "flex flex-col items-center gap-0.5 px-1 py-2.5 text-center text-[10px] leading-tight",
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
          return (
            <li key={item.key}>
              <Link href={item.href} className={className}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
