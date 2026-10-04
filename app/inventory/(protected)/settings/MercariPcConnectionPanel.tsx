"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMercariExistingReadResultsAction } from "@/app/actions/mercariBridge";
import { mercariPcConnectionStatus } from "@/lib/listing/mercariBridge/connectionStatus";
import type { ReadResultView } from "@/lib/listing/mercariBridge/resultView";

const REQUEST_ID = /^[a-f0-9]{64}$/;

export function MercariPcConnectionPanel({ initialRequestId }: { initialRequestId: string }) {
  const [requestId, setRequestId] = useState(initialRequestId);
  const [results, setResults] = useState<ReadResultView[]>([]);
  const [checkedRequestId, setCheckedRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (id: string) => {
    const current = ++generation.current;
    setLoading(true);
    setMessage(null);
    try {
      const response = await getMercariExistingReadResultsAction(id);
      if (current !== generation.current) return;
      if (!response.ok) {
        setResults([]);
        setCheckedRequestId(null);
        setMessage(response.message);
        return;
      }
      setResults(response.results);
      setCheckedRequestId(id);
    } catch {
      if (current === generation.current) {
        setResults([]);
        setCheckedRequestId(null);
        setMessage("接続・読取の記録を取得できませんでした。");
      }
    } finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!REQUEST_ID.test(initialRequestId)) return;
    void load(initialRequestId);
    return () => { generation.current++; };
  }, [initialRequestId, load]);

  const state = mercariPcConnectionStatus(checkedRequestId ? results : []);
  return (
    <section className="max-w-2xl space-y-3 rounded border border-gray-200 bg-white p-4 text-[13px] text-gray-700">
      <h2 className="font-bold text-gray-900">メルカリShops PC連携</h2>
      <p>既存商品の読取依頼に対するPCからの報告と、Shopsの読取結果を確認します。ここでは商品を出品・変更しません。</p>
      <label className="block">読取依頼ID
        <input value={requestId} onChange={event => {
          generation.current++;
          setRequestId(event.target.value.trim());
          setLoading(false);
          setCheckedRequestId(null);
          setResults([]);
          setMessage(null);
        }} maxLength={64} autoComplete="off" spellCheck={false}
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs" />
      </label>
      <button type="button" disabled={loading || !REQUEST_ID.test(requestId)}
        onClick={() => void load(requestId)}
        className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">
        {loading ? "確認中…" : "接続・読取記録を確認"}
      </button>
      {message && <p role="alert" className="text-amber-800">{message}</p>}
      <div className="rounded border border-gray-200 bg-gray-50 p-3" aria-live="polite">
        <p>PC: <strong>{state.pc === "REPORT_RECEIVED" ? "報告受信済み" : "未接続（この依頼の報告なし）"}</strong></p>
        <p>Shops: <strong>{state.shops === "REAUTH_REQUIRED" ? "再認証必要" :
          state.shops === "READ_CONFIRMED" ? "読取確認済み" : "ログイン未確認"}</strong></p>
        {state.recordedAt && <p>最終報告: <time dateTime={state.recordedAt}>{state.recordedAt}</time></p>}
      </div>
      <p className="text-xs text-gray-600">PCの表示は、この読取依頼への報告履歴です。現在オンラインかどうかは判定できません。読取確認も出品可能・出品完了を意味しません。</p>
      <Link href={checkedRequestId ? `/inventory/mercari-bridge?requestId=${checkedRequestId}` : "/inventory/mercari-bridge"}
        className="inline-block text-blue-700 underline">既存商品の照合画面を開く</Link>
    </section>
  );
}
