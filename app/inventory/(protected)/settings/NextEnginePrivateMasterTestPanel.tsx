"use client";

import { useEffect, useState } from "react";
import { checkNextEnginePrivateMasterTest, startNextEnginePrivateMasterTest,
  type PrivateMasterTestResult } from "@/app/actions/nextEnginePrivateMasterTest";

const phaseLabels = {
  AWAITING_UPLOAD: "まだ開始していません。",
  UNKNOWN: "受付結果を確認できません。再送しないでください。",
  QUEUED: "受付済み。商品マスタへの反映待ちです。",
  WAITING: "処理待ちです。",
  PROCESSING: "処理中です。",
  FAILED: "商品マスタへの反映に失敗しました。再送しないでください。",
  MASTER_APPLIED: "商品マスタへ反映されました。内容はまだ確認中です。",
  MASTER_CONFIRMED: "商品マスタの内容を確認しました。商品ページの非公開状態は未確認です。",
} as const;

export function NextEnginePrivateMasterTestPanel() {
  const [supplierCode, setSupplierCode] = useState("");
  const [result, setResult] = useState<PrivateMasterTestResult | null>(null);
  const [pending, setPending] = useState(false);
  const [initialCheckPending, setInitialCheckPending] = useState(true);
  const started = result?.ok && result.state.phase !== "AWAITING_UPLOAD";
  useEffect(() => {
    let active = true;
    void checkNextEnginePrivateMasterTest().then(state => { if (active) setResult(state); })
      .catch(() => { if (active) setResult({ ok: false, message: "確認できませんでした。再送せず担当者に確認してください。" }); })
      .finally(() => { if (active) setInitialCheckPending(false); });
    return () => { active = false; };
  }, []);
  async function run(action: () => Promise<PrivateMasterTestResult>) {
    if (pending) return;
    setPending(true);
    try { setResult(await action()); }
    catch { setResult({ ok: false, message: "確認できませんでした。再送せず担当者に確認してください。" }); }
    finally { setPending(false); }
  }
  return (
    <section className="mt-5 space-y-3 border-t border-gray-200 pt-5">
      <h3 className="font-semibold text-gray-900">商品マスタへの一回限りの接続テスト</h3>
      <p>登録済みの仕入先を使い、販売しない専用テスト商品を一度だけ送ります。商品ページや店舗への出品は行いません。</p>
      <label className="block">使用する仕入先コード
        <input className="mt-1 block w-full rounded border border-gray-300 px-3 py-2" value={supplierCode}
          onChange={event => setSupplierCode(event.target.value)} maxLength={49} autoComplete="off" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-50"
          disabled={pending || initialCheckPending || started || !supplierCode || result?.ok === false}
          onClick={() => void run(() => startNextEnginePrivateMasterTest(supplierCode))}>
          一回だけ登録する
        </button>
        <button type="button" className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50"
          disabled={pending || initialCheckPending} onClick={() => void run(checkNextEnginePrivateMasterTest)}>処理状況を確認</button>
      </div>
      {result && <p role="status">{result.ok ? phaseLabels[result.state.phase] : result.message}</p>}
      {result?.ok && result.state.sku && <p>テスト商品コード: {result.state.sku}</p>}
      <p className="text-amber-800">受付済みでも販売や公開は確認されていません。結果が不明なときは再登録しないでください。</p>
    </section>
  );
}
