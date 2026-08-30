"use client";

import Link from "next/link";
import type { InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { InventoryThumbnail } from "../InventoryThumbnail";

interface InventoryCardListProps {
  rows: InventoryListRow[];
  categoriesById: Record<string, MasterOption>;
  locationsById: Record<string, MasterOption>;
  statusesById: Record<string, StatusOption>;
}

function formatYen(value: number | null): string {
  return value === null ? "-" : `¥${value.toLocaleString("ja-JP")}`;
}

/**
 * BELLO統合業務OS指示書(2026-08-30) §70/§72/§122: モバイル幅
 * (`md`未満)専用のカード型一覧。InventoryTable.tsx(高密度な表、列
 * 表示設定・一覧直接編集・ドラッグ選択等の機能を持つ)をそのまま縮小
 * するのではなく、モバイルでの主用途(一覧を眺めて詳細へ飛ぶ)に絞った
 * 別コンポーネントとして新設した — lib/zaico/secretStore.tsと
 * lib/listing/mercari/secretStore.tsを意図的に別ファイルにしているのと
 * 同じ理由(既存の複雑な仕組みへ無関係な関心事を混ぜない)。列表示設定・
 * 一覧直接編集はこのビューでは扱わない(必要ならデスクトップ幅で行う
 * 前提 — 391pxの画面へ列選択・インライン編集グリッドを持ち込むのは
 * 現実的な操作性にならないため、意図的なスコープ外)。
 */
export function InventoryCardList({ rows, categoriesById, locationsById, statusesById }: InventoryCardListProps) {
  if (rows.length === 0) {
    return <p className="p-6 text-sm text-gray-400">該当する在庫がありません。</p>;
  }

  return (
    <ul className="h-full divide-y divide-gray-100 overflow-y-auto">
      {rows.map((row) => {
        const category = row.categoryId ? categoriesById[row.categoryId] : undefined;
        const location = row.locationId ? locationsById[row.locationId] : undefined;
        const status = row.statusId ? statusesById[row.statusId] : undefined;
        return (
          <li key={row.id}>
            {/* 第六ラウンド§17-18(P0-4): ZAICO級density実測に合わせ
                thumbnail 56px→40px(spec目標36〜44px)、行の縦padding
                を詰め(spec目標: 行高48〜58px)、leading-tightで行間を
                詰める——「above-the-fold 4〜6行以上」を達成する。 */}
            <Link href={`/inventory/${row.id}`} className="flex items-center gap-2.5 px-3 py-1.5 active:bg-gray-50">
              <div className="h-10 w-10 shrink-0">
                <InventoryThumbnail storageKey={row.mainImageThumbnailKey} alt={row.name} size="list" loading="lazy" />
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[12px] font-medium text-gray-900">{row.name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-gray-500">
                  <span className="font-mono">{row.displayId}</span>
                  {category && <span className="truncate">{category.name}</span>}
                  {location && <span className="truncate">{location.name}</span>}
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-[10.5px] text-gray-500">
                  {status && <span className="border border-gray-300 px-1 py-0.5 text-[10px] text-gray-700">{status.label}</span>}
                  <span>数量: {row.quantity}</span>
                  <span className="tabular-nums text-gray-700">{formatYen(row.salePrice ?? row.plannedSalePrice)}</span>
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
