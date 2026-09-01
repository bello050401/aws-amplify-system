"use client";

import { useEffect, useState } from "react";
import { getInventoryCountAction } from "@/app/actions/inventoryCount";
import type { InventoryCursorListFilters } from "@/lib/inventory/inventoryCursorList";

/**
 * 総件数の表示。
 *
 * 【なぜ描画経路から外したか】総件数は本質的に全件読まないと出せない。
 * 一覧の行は表示するぶんだけで足りる。最初はServer Component +
 * Suspenseで後から流す形にしたが、Staging実機で**6回に1回、画面全体が
 * エラーになった**（/inventory/error.tsx が発火）。全件走査がサーバー
 * 描画の一部である限り、そこで起きた失敗は画面ごと巻き込む。
 *
 * 件数は「あると便利な表示」であって、一覧が使えるかどうかとは関係が
 * ない。そこで描画後にクライアントから取りに行き、失敗しても
 * 「—」を出すだけにした。行の表示は件数を待たないし、件数の失敗で
 * 一覧が消えることもない。
 *
 * 取得できなかったときに 0 や推測値を出さないのは、§13.2 と同じ理由
 * ——「取れなかった」と「0件」を混同させない。
 */
export function InventoryTotalCount({ filters }: { filters: InventoryCursorListFilters }) {
  const [label, setLabel] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // filtersはオブジェクトなので、そのまま依存に置くと毎回再取得になる。
  const key = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setLabel(null);
    setFailed(false);
    void (async () => {
      const result = await getInventoryCountAction(JSON.parse(key) as InventoryCursorListFilters);
      if (cancelled) return;
      if (result.ok) setLabel(`${result.total.toLocaleString("ja-JP")}件`);
      else setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (failed) return <span title="件数を取得できませんでした">—</span>;
  if (label === null) return <span className="text-gray-300">集計中…</span>;
  return <>{label}</>;
}
