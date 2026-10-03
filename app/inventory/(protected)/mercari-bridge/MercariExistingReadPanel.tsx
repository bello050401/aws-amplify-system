"use client";

import { useState, useTransition } from "react";
import { requestMercariExistingReadAction } from "@/app/actions/mercariBridge";

export function MercariExistingReadPanel({ inventoryId }: { inventoryId: string }) {
  const [shopId, setShopId] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [repeatRemoteId, setRepeatRemoteId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setRequestId(null);
    if (!inventoryId || remoteId !== repeatRemoteId || !confirmed) {
      setMessage("対象の在庫と既存商品IDをもう一度確認してください。");
      return;
    }
    startTransition(async () => {
      try {
        const result = await requestMercariExistingReadAction({ inventoryId, shopId, remoteId });
        setMessage(result.message);
        if (result.code === "CONNECTOR_NOT_CONFIGURED") setRequestId(result.requestId);
      } catch {
        setMessage("読取依頼を記録できませんでした。通信状態を確認して再度お試しください。");
      }
    });
  }

  return (
    <section className="rounded border border-gray-200 bg-white p-4" aria-label="既存商品照合依頼">
      <h2 className="text-base font-semibold">既存商品だけを照合する</h2>
      <p className="mt-2 text-sm text-gray-600">この操作はBELLOに読取依頼を記録します。Shopsの商品作成・公開・停止・在庫変更は行いません。専用PCでの照合結果が届くまで、出品完了とは表示しません。</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm">BELLO在庫ID
          <input value={inventoryId} readOnly className="mt-1 block w-full rounded border border-gray-300 bg-gray-100 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">Shops店舗ID
          <input value={shopId} onChange={(event) => setShopId(event.target.value)} required minLength={8} maxLength={100}
            autoComplete="off" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">既存の商品ID
          <input value={remoteId} onChange={(event) => setRemoteId(event.target.value)} required minLength={8} maxLength={100}
            autoComplete="off" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">既存の商品IDを再入力
          <input value={repeatRemoteId} onChange={(event) => setRepeatRemoteId(event.target.value)} required minLength={8} maxLength={100}
            autoComplete="off" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
          <span>店舗と既存の商品IDをShopsの画面で確認しました。この在庫への紐付けは後から別の商品IDに変更できないことを理解しています。</span>
        </label>
        <button type="submit" disabled={pending || !inventoryId || !confirmed || remoteId !== repeatRemoteId}
          className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {pending ? "依頼を記録中…" : "読取だけを依頼する"}
        </button>
      </form>
      {message && <p role={requestId ? "status" : "alert"} className="mt-3 text-sm">{message}</p>}
      {requestId && <p className="mt-2 break-all text-xs text-gray-600">読取依頼ID: {requestId}</p>}
      <p className="mt-4 text-xs text-gray-500">専用PCのログイン画面は準備中です。本人の通常ログインが必要になるまでは、この画面で追加操作をする必要はありません。</p>
    </section>
  );
}
