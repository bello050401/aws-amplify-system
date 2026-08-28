"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  BulkIcon,
  HomeIcon,
  ListIcon,
  NewItemIcon,
  ReceiveIcon,
  ScanIcon,
  ShipIcon,
  StocktakeIcon,
} from "@/components/icons";

/** PC版サイドナビゲーション。現行PC版UIが存在しないため新規に用意するが、
 * ここでもモバイルと同一のInventoryService/APIを利用する(データ分離しない)。 */
const NAV = [
  { href: "/", label: "ホーム", Icon: HomeIcon },
  { href: "/inventory", label: "在庫一覧", Icon: ListIcon },
  { href: "/inventory/new", label: "新規登録", Icon: NewItemIcon },
  { href: "/scan", label: "スキャン検索", Icon: ScanIcon },
  { href: "/receive", label: "入庫", Icon: ReceiveIcon },
  { href: "/ship", label: "出庫", Icon: ShipIcon },
  { href: "/stocktake", label: "棚卸", Icon: StocktakeIcon },
  { href: "/bulk", label: "一括操作", Icon: BulkIcon },
];

export function DesktopSidebar() {
  const pathname = usePathname();
  const { user, signOut, isBackendConfigured } = useAuth();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-bello-100 bg-white md:flex">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-bello-800 text-sm font-bold text-white">
          B
        </div>
        <div>
          <p className="text-sm font-bold text-bello-900">BELLO在庫管理</p>
          {!isBackendConfigured && <p className="text-[10px] text-accent-500">ローカル動作確認モード</p>}
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${
                active ? "bg-bello-800 text-white" : "text-bello-600 hover:bg-bello-50"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
      </nav>
      {user && (
        <div className="border-t border-bello-100 px-4 py-4">
          <p className="truncate text-xs text-bello-500">{user.email}</p>
          <button onClick={() => signOut()} className="mt-2 text-xs font-semibold text-bello-700 underline">
            ログアウト
          </button>
        </div>
      )}
    </aside>
  );
}
