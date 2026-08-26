"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";

const links = [
  { href: "/admin", label: "特集一覧" },
  { href: "/admin/search", label: "商品検索" },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav className="flex items-center justify-between border-b border-line px-6 py-4">
      <ConfigureAmplifyClientSide />
      <div className="flex items-center gap-8">
        <span className="text-sm font-medium text-ink">特集ページ管理</span>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`text-xs uppercase tracking-label ${
              pathname === link.href ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <button
        onClick={async () => {
          await signOut();
          router.push("/admin/login");
        }}
        className="text-xs uppercase tracking-label text-muted hover:text-ink"
      >
        ログアウト
      </button>
    </nav>
  );
}
