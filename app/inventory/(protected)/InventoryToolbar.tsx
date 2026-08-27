import Link from "next/link";
import type { InventoryRole } from "@/lib/amplify/requireInventoryUser";

interface InventoryToolbarProps {
  role: InventoryRole;
  q?: string;
  categoryId?: string;
  locationId?: string;
  statusId?: string;
  advancedOpen: boolean;
  totalLabel: string;
}

/**
 * Top operation bar (spec §23). 新規登録 is the one high-frequency
 * action and gets the one filled/dark button; インポート・エクスポート・
 * 直接編集 are visually present (so the structure doesn't need rework
 * when they land — spec §26/§20) but disabled with a tooltip, since none
 * of them are implemented yet (spec §34) and a dead button that looks
 * clickable is worse than one that visibly isn't.
 */
export function InventoryToolbar({ role, q, categoryId, locationId, statusId, advancedOpen, totalLabel }: InventoryToolbarProps) {
  const canEdit = role === "ADMIN" || role === "EDITOR";
  const advancedHref = (() => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (categoryId) sp.set("categoryId", categoryId);
    if (locationId) sp.set("locationId", locationId);
    if (statusId) sp.set("statusId", statusId);
    if (!advancedOpen) sp.set("advanced", "1");
    const qs = sp.toString();
    return qs ? `/inventory?${qs}` : "/inventory";
  })();

  return (
    <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-bold text-gray-900">在庫一覧</h1>
        <span className="text-xs text-gray-400">{totalLabel}</span>
        <form action="/inventory" method="get" className="flex items-center">
          {categoryId && <input type="hidden" name="categoryId" value={categoryId} />}
          {locationId && <input type="hidden" name="locationId" value={locationId} />}
          {statusId && <input type="hidden" name="statusId" value={statusId} />}
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="物品名 / SKU"
            className="w-48 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
        </form>
        <Link
          href={advancedHref}
          className={`border px-2 py-1 text-[12px] ${advancedOpen ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
        >
          詳細検索
        </Link>
      </div>
      <div className="flex items-center gap-2">
        {canEdit ? (
          <Link href="/inventory/new" className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white hover:bg-gray-800">
            + 新規登録
          </Link>
        ) : null}
        <button
          type="button"
          disabled
          title="次のPhaseで実装予定"
          className="border border-gray-200 px-2 py-1.5 text-[12px] text-gray-300"
        >
          直接編集
        </button>
        <button
          type="button"
          disabled
          title="次のPhaseで実装予定"
          className="border border-gray-200 px-2 py-1.5 text-[12px] text-gray-300"
        >
          インポート
        </button>
        <button
          type="button"
          disabled
          title="次のPhaseで実装予定"
          className="border border-gray-200 px-2 py-1.5 text-[12px] text-gray-300"
        >
          エクスポート
        </button>
      </div>
    </div>
  );
}
