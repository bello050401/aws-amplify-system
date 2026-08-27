"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/products", label: "商品一覧" },
  { href: "/products/new", label: "商品登録" },
  { href: "/settings/templates", label: "説明テンプレート" },
  { href: "/settings/shipping", label: "配送テンプレート" },
  { href: "/settings/categories", label: "カテゴリーお気に入り" },
  { href: "/settings/mercari", label: "メルカリ連携設定" },
  { href: "/logs", label: "APIログ" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen w-full flex-col md:flex-row">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <span className="font-semibold">家具リユース商品管理</span>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setOpen((v) => !v)}
          aria-label="メニュー切替"
        >
          メニュー
        </button>
      </header>

      <nav
        className={`w-full shrink-0 border-b border-slate-200 bg-white md:block md:w-60 md:border-b-0 md:border-r ${
          open ? "block" : "hidden"
        }`}
      >
        <div className="hidden px-4 py-4 text-lg font-semibold md:block">
          家具リユース
          <br />
          商品管理システム
        </div>
        <ul className="flex flex-col gap-0.5 p-2">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`block rounded-md px-3 py-2 text-sm ${
                    active
                      ? "bg-indigo-50 font-medium text-indigo-700"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
