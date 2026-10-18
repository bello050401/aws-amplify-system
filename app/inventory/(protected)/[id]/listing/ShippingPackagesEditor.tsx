"use client";
import { SHIPPING_RANKS, SHIPPING_RANK_LABEL, type ShippingRank } from "@/lib/shipping/rank";
import type { ShippingPackage } from "@/lib/shipping/packages";

export function ShippingPackagesEditor({ packages, onChange, estimatedRank }: { packages: ShippingPackage[];
  onChange: (value: ShippingPackage[]) => void; estimatedRank: ShippingRank | null }) {
  return <fieldset className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
    <legend className="px-1 text-sm font-semibold">らくらく家財の荷物・サイズ</legend>
    <p className="mb-3 text-xs text-gray-600">配送判定の推定サイズ：{estimatedRank ? SHIPPING_RANK_LABEL[estimatedRank] : "寸法不足のため未判定"}。梱包後のサイズに変更できます。</p>
    <div className="space-y-3">{packages.map((p, i) => <div key={p.id} className="rounded border bg-white p-3">
      <div className="mb-2 flex items-center justify-between"><strong className="text-sm">{i + 1}口目</strong>
        {packages.length > 1 && <button type="button" className="text-xs text-red-700 underline" onClick={() => onChange(packages.filter(x => x.id !== p.id))} aria-label={`${i + 1}口目を削除`}>削除</button>}</div>
      <label className="mt-2 block text-xs text-gray-600">家財便サイズ<select aria-label={`${i + 1}口目の家財便サイズ`} className="mt-1 block w-full rounded border bg-white p-2 text-sm" value={p.rank ?? "AUTO"}
        onChange={e => onChange(packages.map(x => x.id === p.id ? { ...x, rank: e.target.value === "AUTO" ? null : e.target.value as ShippingRank } : x))}>
        <option value="AUTO">配送判定に合わせる{estimatedRank ? `：${SHIPPING_RANK_LABEL[estimatedRank]}` : "（未判定）"}</option>
        {SHIPPING_RANKS.map(rank => <option key={rank} value={rank}>{SHIPPING_RANK_LABEL[rank]}</option>)}
      </select></label>
    </div>)}</div>
    <button type="button" disabled={packages.length >= 20} className="mt-3 rounded border border-blue-600 px-3 py-2 text-sm text-blue-700 disabled:opacity-50"
      onClick={() => onChange([...packages, { id: crypto.randomUUID(), name: "", rank: estimatedRank }])}>＋ 配送する荷物を追加</button>
    <p className="mt-2 text-xs text-gray-500">荷物の内容は共通の商品情報と一緒に保存されます。</p>
  </fieldset>;
}
