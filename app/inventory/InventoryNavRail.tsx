import Link from "next/link";

/**
 * Thin fixed icon rail (spec §18) — the left-most of the three layers
 * (rail → filter sidebar → main area, spec §17). Only 在庫一覧 is wired
 * up in Phase 3; the rest are placeholders so the *structure* for future
 * modules exists without pretending they're built. A disabled item has
 * no href and a title tooltip explaining why, rather than a dead link.
 */
const NAV_ITEMS = [
  { key: "inventory", label: "在庫一覧", href: "/inventory", enabled: true },
  { key: "receiving", label: "入庫", href: null, enabled: false },
  { key: "shipping", label: "出庫", href: null, enabled: false },
  { key: "stocktake", label: "棚卸", href: null, enabled: false },
  { key: "orders", label: "受注管理", href: null, enabled: false },
  { key: "purchasing", label: "発注管理", href: null, enabled: false },
  { key: "tools", label: "ツール", href: null, enabled: false },
  { key: "settings", label: "設定", href: null, enabled: false },
] as const;

export function InventoryNavRail({ current = "inventory" }: { current?: string }) {
  return (
    <nav className="flex w-16 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex h-12 items-center justify-center border-b border-gray-200">
        <span className="text-[11px] font-bold tracking-wide text-gray-700">BELLO</span>
      </div>
      <ul className="flex flex-1 flex-col py-1">
        {NAV_ITEMS.map((item) => {
          const isCurrent = item.key === current;
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
