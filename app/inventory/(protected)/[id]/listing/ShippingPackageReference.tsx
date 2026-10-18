"use client";
import { useEffect, useMemo, useState } from "react";
import { getShippingPackageQuoteDataAction } from "@/app/actions/shipping";
import { buildPackageQuote, type ShippingPackage, type PackageQuoteData } from "@/lib/shipping/packages";
import { SHIPPING_RANK_LABEL } from "@/lib/shipping/rank";
const yen = (value: number | null) => value == null ? "未算出" : `¥${value.toLocaleString("ja-JP")}`;

export function ShippingPackageReference({ inventoryId, packages, goodsPrice }: { inventoryId: string; packages: ShippingPackage[]; goodsPrice: number | null }) {
  const [destination, setDestination] = useState("");
  const [data, setData] = useState<PackageQuoteData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    getShippingPackageQuoteDataAction(inventoryId)
      .then(value => { if (!cancelled) { setData(value); setBusy(false); } })
      .catch(() => { if (!cancelled) { setError("送料を取得できませんでした。画面を開き直してください。"); setBusy(false); } });
    return () => { cancelled = true; };
  }, [inventoryId]);
  const quote = useMemo(() => data ? buildPackageQuote({ ...data, packages, plannedPrice: goodsPrice, destinationKey: destination || null, requireAllPrefectures: true }) : null,
    [data, packages, destination, goodsPrice]);
  return <section aria-label="送料込み参考価格" className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
    <h3 className="font-semibold">送料込み参考価格</h3>
    <label className="mt-3 block text-xs text-gray-600">配送先<select value={destination} onChange={e => setDestination(e.target.value)} className="mt-1 block w-full rounded border bg-white p-2 text-sm">
      <option value="">参考送料（47都道府県の中央値）</option>
      {destination && !quote?.regions.some(r => r.key === destination) &&
        <option value={destination}>選択地域（このサイズの料金未登録）</option>}
      {quote?.regions.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
    </select></label>
    {busy ? <p className="mt-3 text-sm" role="status">送料を計算しています…</p> : error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : quote && <>
      <div className="mt-3 divide-y">{quote.packages.map((p, i) => <div key={p.id} className="flex justify-between gap-3 py-2 text-sm"><div>{i + 1}口目{p.name !== `${i + 1}口目` ? `：${p.name}` : ""}<div className="text-xs text-gray-500">{p.rank ? SHIPPING_RANK_LABEL[p.rank] : "サイズ未選択"}</div></div><span className={p.fee == null ? "text-amber-700" : "font-medium"}>{p.reason ?? yen(p.fee)}</span></div>)}</div>
      <dl className="mt-2 space-y-2 border-t pt-3 text-sm"><div className="flex justify-between"><dt>送料合計（{quote.packages.length}口）</dt><dd className="font-semibold">{yen(quote.shippingTotal)}</dd></div>
        <div className="flex justify-between"><dt>基準価格（送料別）</dt><dd>{yen(quote.plannedPrice)}</dd></div>
        <div className="flex justify-between border-t pt-3"><dt>送料込み参考価格</dt><dd className="text-xl font-bold">{yen(quote.referenceTotal)}</dd></div></dl>
      <p className="mt-3 text-xs text-gray-500">{destination ? "選択地域への各口の送料を合計しています。" : "47都道府県への送料の中央値を口ごとに合計しています。北海道は4地域の中央値を1県分として計算します。配送先を選ぶと、その地域の送料を確認できます。"}料金は税込・埼玉県発送の目安です。組立て等のオプション料は含みません。</p>
    </>}
  </section>;
}
