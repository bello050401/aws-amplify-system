"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Item } from "@/lib/types";
import { getInventoryService } from "@/lib/api";
import { useMasterData } from "@/lib/hooks/useMasterData";
import { formatQuantity } from "@/lib/utils/format";
import { PinIcon } from "@/components/icons";

/**
 * 在庫一覧の1行(指示書 §6-5)。PC版・モバイル版で共通利用する。
 * 左:サムネイル / 中央:ステータス+商品名 / 右:数量+保管場所。
 */
export function InventoryListItem({ item }: { item: Item }) {
  const { categories, locations } = useMasterData();
  const [thumbUrl, setThumbUrl] = useState<string>("");
  const category = categories.find((c) => c.id === item.categoryId);
  const location = locations.find((l) => l.id === item.locationId);

  useEffect(() => {
    let active = true;
    if (item.thumbnailKey) {
      getInventoryService()
        .getImageUrl(item.thumbnailKey)
        .then((url) => active && setThumbUrl(url));
    }
    return () => {
      active = false;
    };
  }, [item.thumbnailKey]);

  return (
    <Link
      href={`/inventory/${item.id}`}
      className="tap-target flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card active:bg-bello-50"
    >
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-bello-50">
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg text-bello-200">📦</div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap gap-1">
          {item.status && (
            <span className="rounded-full bg-bello-100 px-2 py-0.5 text-[11px] font-medium text-bello-700">
              {item.status}
            </span>
          )}
          {category && (
            <span className="rounded-full bg-accent-100 px-2 py-0.5 text-[11px] font-medium text-accent-700">
              {category.name}
            </span>
          )}
        </div>
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-bello-900">{item.name}</p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-base font-bold text-bello-900">
          {formatQuantity(item.quantity)}
          <span className="ml-0.5 text-xs font-normal text-bello-400">{item.unit}</span>
        </p>
        {location && (
          <p className="mt-0.5 flex items-center justify-end gap-0.5 text-[11px] text-bello-400">
            <PinIcon className="h-3 w-3" />
            {location.name}
          </p>
        )}
      </div>
    </Link>
  );
}
