"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";
import { EmptyState } from "@/components/common/EmptyState";
import { getInventoryService } from "@/lib/api";
import type { ItemHistoryEntry, StockMovement } from "@/lib/types";
import { formatDateTimeJST } from "@/lib/utils/date";

const ACTION_LABEL: Record<ItemHistoryEntry["action"], string> = {
  CREATE: "新規作成",
  UPDATE: "更新",
  DELETE: "削除",
  DUPLICATE: "複製",
};
const MOVEMENT_LABEL: Record<StockMovement["type"], string> = {
  RECEIVE: "入庫",
  SHIP: "出庫",
  MOVE: "移動",
  ADJUST: "調整",
  STOCKTAKE: "棚卸",
};

type Entry =
  | { kind: "history"; at: string; data: ItemHistoryEntry }
  | { kind: "movement"; at: string; data: StockMovement };

/** 変更履歴画面(指示書 §7-2)。物品詳細の「変更履歴」から遷移。 */
export default function ItemHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const service = getInventoryService();
    Promise.all([service.getItemHistory(id), service.getItemMovements(id)]).then(([hist, mov]) => {
      if (!active) return;
      const combined: Entry[] = [
        ...hist.map((h): Entry => ({ kind: "history", at: h.changedAt, data: h })),
        ...mov.map((m): Entry => ({ kind: "movement", at: m.createdAt, data: m })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      setEntries(combined);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div className="pb-24">
      <MobileHeader title="変更履歴" />
      <div className="space-y-2 px-4 py-4 md:px-0">
        {loading && <LoadingOverlay />}
        {!loading && entries.length === 0 && <EmptyState title="履歴がありません" />}
        {entries.map((e, i) => (
          <div key={i} className="rounded-2xl bg-white p-4 shadow-card">
            <div className="mb-1 flex items-center justify-between text-xs text-bello-400">
              <span>{formatDateTimeJST(e.at)}</span>
              <span>{e.kind === "history" ? e.data.changedBy : e.data.operatorName}</span>
            </div>
            {e.kind === "history" ? (
              <div>
                <p className="text-sm font-bold text-bello-800">{ACTION_LABEL[e.data.action]}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-bello-500">
                  {e.data.changes.slice(0, 6).map((c, j) => (
                    <li key={j}>
                      {c.field}: {JSON.stringify(c.oldValue)} → {JSON.stringify(c.newValue)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm font-bold text-bello-800">
                {MOVEMENT_LABEL[e.data.type]} {e.data.quantity > 0 ? "+" : ""}
                {e.data.quantity}
                {e.data.note && <span className="ml-2 font-normal text-bello-400">{e.data.note}</span>}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
