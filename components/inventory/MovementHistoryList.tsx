"use client";

import { useEffect, useState } from "react";
import { getInventoryService } from "@/lib/api";
import type { MovementType, StockMovement } from "@/lib/types";
import { formatDateTimeJST } from "@/lib/utils/date";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";

/** 入庫一覧・出庫一覧で共通利用する履歴リスト(指示書 §17, §18)。 */
export function MovementHistoryList({ type, emptyLabel }: { type: MovementType; emptyLabel: string }) {
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [itemNames, setItemNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const service = getInventoryService();
    service.listMovements(type).then(async (list) => {
      setMovements(list);
      const uniqueIds = Array.from(new Set(list.map((m) => m.itemId)));
      const names: Record<string, string> = {};
      await Promise.all(
        uniqueIds.map(async (id) => {
          const item = await service.getItem(id);
          if (item) names[id] = item.name;
        })
      );
      setItemNames(names);
    });
  }, [type]);

  if (!movements) return <LoadingOverlay />;
  if (movements.length === 0) return <EmptyState title={emptyLabel} />;

  return (
    <div className="space-y-2 px-4 py-4 md:px-0">
      {movements.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-card">
          <div>
            <p className="text-xs text-bello-400">{formatDateTimeJST(m.createdAt)}</p>
            <p className="text-sm font-semibold text-bello-900">{itemNames[m.itemId] ?? m.itemId}</p>
            <p className="text-xs text-bello-400">
              {m.operatorName ?? "-"}
              {m.note ? ` ・ ${m.note}` : ""}
            </p>
          </div>
          <p className="text-lg font-bold text-bello-800">{m.quantity}</p>
        </div>
      ))}
    </div>
  );
}
