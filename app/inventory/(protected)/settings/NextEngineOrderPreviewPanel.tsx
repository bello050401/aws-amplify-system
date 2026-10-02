"use client";

import { useState } from "react";
import { previewNextEngineOrdersAction, type NextEngineOrderPreviewResult } from "@/app/actions/nextEngineOrderPreview";
import type { MasterCandidates } from "@/lib/listing/nextEngine/masterCandidates";

const neTime = (value: string) => value.replace("T", " ") + (value.length === 16 ? ":00" : "");

/** No request runs until an admin chooses one listed shop and a time window. */
export function NextEngineOrderPreviewPanel({ shops, bindingRef }: {
  shops: MasterCandidates["shops"]; bindingRef: MasterCandidates["bindingRef"];
}) {
  const [shopId, setShopId] = useState("");
  const [from, setFrom] = useState("");
  const [before, setBefore] = useState("");
  const [result, setResult] = useState<NextEngineOrderPreviewResult | null>(null);
  const [pending, setPending] = useState(false);
  async function read() {
    if (pending || !shops.some(shop => shop.id === shopId) || !from || !before) return;
    setPending(true); setResult(null);
    try { setResult(await previewNextEngineOrdersAction({ shopId, from: neTime(from), before: neTime(before) }, bindingRef)); }
    catch { setResult({ ok: false, message: "受注を確認できませんでした。" }); }
    finally { setPending(false); }
  }
  return (
    <div className="space-y-2 border-t border-gray-200 pt-3">
      <h4 className="font-medium">NE受注の限定確認（表示のみ）</h4>
      <p>店舗を1つ選び、NEの日本時間で24時間以内を指定します。最大50件の番号・取込日時・状態コードだけを表示します。受注の取込や在庫変更はしません。</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">対象店舗
          <select className="mt-1 w-full rounded border border-gray-300 px-2 py-2" value={shopId}
            disabled={pending}
            onChange={event => { setShopId(event.target.value); setResult(null); }}>
            <option value="">店舗を選択</option>
            {shops.map(shop => <option key={shop.id} value={shop.id}>{shop.name}（ID {shop.id}）</option>)}
          </select>
        </label>
        <label className="block">開始日時
          <input type="datetime-local" step="1" className="mt-1 w-full rounded border border-gray-300 px-2 py-2"
            disabled={pending}
            value={from} onChange={event => { setFrom(event.target.value); setResult(null); }} />
        </label>
        <label className="block">終了日時（含まない）
          <input type="datetime-local" step="1" className="mt-1 w-full rounded border border-gray-300 px-2 py-2"
            disabled={pending}
            value={before} onChange={event => { setBefore(event.target.value); setResult(null); }} />
        </label>
      </div>
      <button type="button" className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50"
        disabled={pending || !shops.some(shop => shop.id === shopId) || !from || !before}
        onClick={() => void read()}>{pending ? "確認中…" : "この店舗と期間の受注を確認"}</button>
      {result && <div role="status" className="space-y-1">
        {!result.ok ? <p className="text-amber-800">{result.message}</p> : <>
          <p>{result.orders.length}件を確認しました。表示した内容はBELLOへ取り込んでいません。</p>
          {result.orders.length > 0 && <ul className="list-inside list-disc">
            {result.orders.map(order => <li key={order.orderId}>
              NE受注ID {order.orderId} ／ 取込 {order.importedAt} ／ 状態コード {order.statusId}
            </li>)}
          </ul>}
        </>}
      </div>}
    </div>
  );
}
