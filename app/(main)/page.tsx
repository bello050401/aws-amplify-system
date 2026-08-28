"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { HomeTiles } from "@/components/home/HomeTiles";
import { getInventoryService } from "@/lib/api";
import { formatQuantity } from "@/lib/utils/format";
import { useAuth } from "@/lib/auth/AuthProvider";
import { SearchIcon } from "@/components/icons";

export default function HomePage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<{ count: number; quantity: number } | null>(null);

  useEffect(() => {
    let active = true;
    getInventoryService()
      .searchItems({ pageSize: 1 })
      .then((res) => active && setSummary({ count: res.totalCount, quantity: res.totalQuantity }))
      .catch(() => active && setSummary(null));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <MobileHeader title="BELLO在庫管理" hideBack />

      <div className="px-4 pt-4 md:px-0">
        <Link
          href="/inventory"
          className="tap-target mb-4 flex items-center gap-2 rounded-full border border-bello-200 bg-white px-4 py-3 text-sm text-bello-400 shadow-card"
        >
          <SearchIcon className="h-5 w-5 text-bello-300" />
          何をお探しですか?
        </Link>

        {summary && (
          <div className="mb-4 flex items-center justify-between rounded-2xl bg-white px-4 py-3 text-sm shadow-card">
            <span className="text-bello-500">
              こんにちは{user?.displayName ? `、${user.displayName}さん` : ""}
            </span>
            <span className="font-semibold text-bello-800">
              {formatQuantity(summary.count)}件 / 合計{formatQuantity(summary.quantity)}
            </span>
          </div>
        )}
      </div>

      <HomeTiles />
    </div>
  );
}
