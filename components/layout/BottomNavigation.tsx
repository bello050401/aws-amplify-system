"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, ListIcon, ReceiveIcon, ShipIcon } from "@/components/icons";

/**
 * モバイル下部固定ナビゲーション(指示書 §4-2)。
 * iPhoneのHome Indicatorと重ならないようsafe-area-inset-bottomを確保し、
 * タップ領域を44px以上確保する。PC幅では非表示(md:hidden)。
 */
const TABS = [
  { href: "/", label: "ホーム", Icon: HomeIcon, match: (p: string) => p === "/" },
  { href: "/inventory", label: "在庫一覧", Icon: ListIcon, match: (p: string) => p.startsWith("/inventory") },
  { href: "/receive/history", label: "入庫一覧", Icon: ReceiveIcon, match: (p: string) => p.startsWith("/receive") },
  { href: "/ship/history", label: "出庫一覧", Icon: ShipIcon, match: (p: string) => p.startsWith("/ship") },
];

export function BottomNavigation() {
  const pathname = usePathname();

  return (
    <nav className="pb-safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-bello-100 bg-white/95 backdrop-blur md:hidden">
      {TABS.map(({ href, label, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            className="tap-target flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
          >
            <Icon className={`h-6 w-6 ${active ? "text-bello-700" : "text-bello-300"}`} />
            <span className={`text-[11px] ${active ? "font-semibold text-bello-700" : "text-bello-400"}`}>
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
