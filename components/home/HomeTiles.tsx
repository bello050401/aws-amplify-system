"use client";

import Link from "next/link";
import {
  BulkIcon,
  NewItemIcon,
  ReceiveIcon,
  ScanIcon,
  ShipIcon,
  StocktakeIcon,
} from "@/components/icons";

/**
 * ホーム画面の大型タイルメニュー(指示書 §5)。
 * ZAICOの「大きなタイルで迷わず選べる」という機能面を参考にしつつ、
 * 配色・カード形状・タイポグラフィはBELLO独自(指示書 §23)。
 */
const TILES = [
  { href: "/receive", label: "入庫", Icon: ReceiveIcon, color: "from-bello-600 to-bello-700" },
  { href: "/ship", label: "出庫", Icon: ShipIcon, color: "from-accent-500 to-accent-600" },
  { href: "/stocktake", label: "棚卸", Icon: StocktakeIcon, color: "from-bello-500 to-bello-600" },
  { href: "/bulk", label: "一括操作", Icon: BulkIcon, color: "from-bello-700 to-bello-800" },
  { href: "/inventory/new", label: "新規登録", Icon: NewItemIcon, color: "from-accent-400 to-accent-500" },
  { href: "/scan", label: "スキャン検索", Icon: ScanIcon, color: "from-bello-800 to-bello-900" },
];

export function HomeTiles() {
  return (
    <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-3 md:gap-4 md:px-0">
      {TILES.map(({ href, label, Icon, color }) => (
        <Link
          key={href}
          href={href}
          className={`tap-target flex aspect-square flex-col items-center justify-center gap-3 rounded-bello bg-gradient-to-br text-white shadow-card transition active:scale-[0.97] md:aspect-[4/3] ${color}`}
        >
          <Icon className="h-10 w-10 md:h-9 md:w-9" />
          <span className="text-base font-bold md:text-sm">{label}</span>
        </Link>
      ))}
    </div>
  );
}
