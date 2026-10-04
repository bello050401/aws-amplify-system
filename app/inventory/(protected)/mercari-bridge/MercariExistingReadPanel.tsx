"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { getMercariExistingReadResultsAction, requestMercariExistingReadAction } from "@/app/actions/mercariBridge";
import type { ReadResultView } from "@/lib/listing/mercariBridge/resultView";

const statusLabels: Record<string, string> = {
  CONNECTOR_NOT_CONFIGURED: "PCの読取なし", AUTH_REQUIRED: "ログインが必要", UNKNOWN: "確認できませんでした",
  IDENTITY_MISMATCH: "店舗・商品IDが不一致", NOT_PRIVATE: "非公開ではありません",
  DIFFERENT: "保存内容に差異あり", INCOMPLETE: "一部だけ確認済み", CORE_FIELDS_MATCH: "主要項目が一致（出品確認ではありません）",
};
const outcomeLabels: Record<string, string> = {
  MATCH: "一致", DIFFERENT: "差異あり", UNOBSERVED: "未確認", NO_BELLO_EXPECTATION: "BELLO側に比較値なし",
};
const fieldLabels: Record<string, string> = {
  inventoryCode: "商品管理コード", title: "商品名", description: "説明", priceYen: "販売価格",
  quantity: "数量", categoryPath: "カテゴリー", brand: "ブランド", condition: "状態",
  shippingMethod: "配送方法", shippingPayer: "送料負担", shippingOrigin: "発送元",
  shippingDays: "発送日数", imageCount: "画像枚数", primaryImageIdentity: "主画像",
};

export function MercariExistingReadPanel({ inventoryId, initialRequestId }: {
  inventoryId: string; initialRequestId: string;
}) {
  const [shopId, setShopId] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [repeatRemoteId, setRepeatRemoteId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(initialRequestId || null);
  const [results, setResults] = useState<ReadResultView[] | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

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
        if (result.code === "CONNECTOR_NOT_CONFIGURED") {
          setRequestId(result.requestId);
          setResults(null);
          const url = new URL(window.location.href);
          url.searchParams.set("requestId", result.requestId);
          window.history.replaceState(null, "", url);
        }
      } catch {
        setMessage("読取依頼を記録できませんでした。通信状態を確認して再度お試しください。");
      }
    });
  }

  function refreshResults() {
    if (!requestId) return;
    setResultMessage(null);
    startTransition(async () => {
      try {
        const result = await getMercariExistingReadResultsAction(requestId);
        if (!result.ok) { setResultMessage(result.message); return; }
        setResults(result.results);
        setResultMessage(result.results.length ? "保存済みの照合結果を読み込みました。" : "照合結果はまだ届いていません。");
      } catch {
        setResultMessage("照合結果を取得できませんでした。");
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
      {requestId && <div className="mt-4 border-t border-gray-200 pt-3">
        <p className="break-all text-xs text-gray-600">読取依頼ID: {requestId}</p>
        <Link href={`/inventory/settings?tab=mercariBridge&requestId=${requestId}`}
          className="mt-2 inline-block text-sm text-blue-700 underline">PC接続とShops読取状態を設定で確認</Link>
        <button type="button" onClick={refreshResults} disabled={pending}
          className="mt-2 rounded border border-gray-400 px-3 py-2 text-sm disabled:opacity-40">照合結果を確認する</button>
        {resultMessage && <p role="status" className="mt-2 text-sm">{resultMessage}</p>}
        {results?.map((result) => <div key={result.attemptId} className="mt-3 rounded border border-gray-200 p-3 text-sm">
          <p><strong>{statusLabels[result.status] ?? "確認できませんでした"}</strong> · {result.recordedAt}</p>
          {result.reasonCode && <p className="text-gray-600">理由コード: {result.reasonCode}</p>}
          {result.visibility && <p className="text-gray-600">非公開状態: {result.visibility === "PRIVATE_OBSERVED" ? "確認済み" : result.visibility === "NOT_PRIVATE" ? "非公開ではありません" : "未確認"}</p>}
          {Object.entries(result.fields).length > 0 && <ul className="mt-1 list-disc pl-5">
            {Object.entries(result.fields).map(([field, outcome]) =>
              <li key={field}>{fieldLabels[field] ?? field}: {outcomeLabels[outcome] ?? "未確認"}</li>)}
          </ul>}
        </div>)}
      </div>}
      <p className="mt-4 text-xs text-gray-500">PCの「BELLOメルカリ照合」を開き、BELLOとShopsへ専用ブラウザで通常ログインした後、この読取依頼IDを指定して照合します。結果は上のボタンで確認できます。ログインを済ませただけでは照合完了になりません。</p>
    </section>
  );
}
