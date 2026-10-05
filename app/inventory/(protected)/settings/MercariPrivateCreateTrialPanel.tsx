"use client";

import { useCallback, useEffect, useState } from "react";
import { privateCreateExportForUpload } from
  "@/lib/listing/mercariBridge/privateCreateImport";

type TrialView = { claim: { attemptId: string; recordedAt: string } | null;
  result: { status: string; reasonCode: string | null; recordedAt: string } | null };
type ImportKind = "BELLO_PRIVATE_CREATE_CLAIM" | "BELLO_PRIVATE_CREATE_UI_ATTEMPT";
const path = "/api/inventory/mercari-bridge/private-create-trial";
const header = { "x-bello-mercari-bridge": "PRIVATE_CREATE_TRIAL" };

export function MercariPrivateCreateTrialPanel() {
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [claimFile, setClaimFile] = useState<File | null>(null);
  const [resultFile, setResultFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [acceptedKind, setAcceptedKind] = useState<ImportKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(path, { method: "GET", credentials: "same-origin",
      headers: header, cache: "no-store", redirect: "error" });
    if (!response.ok) throw Error("Trial status unavailable");
    const payload = await response.json();
    if (payload?.ok !== true || !payload.claim && payload.result)
      throw Error("Trial status invalid");
    setTrial({ claim: payload.claim ?? null, result: payload.result ?? null });
  }, []);

  useEffect(() => { void refresh().catch(() =>
    setMessage("試行記録を確認できませんでした。")); }, [refresh]);

  async function submit(kind: ImportKind, file: File | null) {
    if (!file || file.size < 1 || file.size > 2048 || pending || trial === null) {
      setMessage("固定対象の記録ファイルを確認してください。");
      return;
    }
    setPending(true);
    setMessage(null);
    let accepted = false;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const record = privateCreateExportForUpload(parsed, kind,
        kind === "BELLO_PRIVATE_CREATE_UI_ATTEMPT" ? trial?.claim?.attemptId : undefined);
      const response = await fetch(path, { method: "POST", credentials: "same-origin",
        headers: { ...header, "Content-Type": "application/json" },
        body: JSON.stringify(record), cache: "no-store", redirect: "error" });
      if (!response.ok) throw Error("Trial import rejected");
      const receipt = await response.json();
      if (receipt?.ok !== true || receipt.stored !== true ||
          receipt.attemptId !== record.attemptId || receipt.listingConfirmed !== false ||
          receipt.status !== (kind === "BELLO_PRIVATE_CREATE_CLAIM" ?
            "CLAIMED" : "UI_ATTEMPT_UNVERIFIED"))
        throw Error("Trial receipt differs");
      accepted = true;
      setAcceptedKind(kind);
      await refresh();
      setMessage(kind === "BELLO_PRIVATE_CREATE_CLAIM" ?
        "一回限りの試行マーカーをBELLOへ保存しました。対象を確認してから通常画面へ進んでください。" :
        "通常画面の操作を通信未確認として記録しました。新規登録や非公開保存の成功を示しません。");
      if (kind === "BELLO_PRIVATE_CREATE_CLAIM") setClaimFile(null);
      else setResultFile(null);
    } catch {
      setMessage(accepted ?
        "BELLOは記録を受信しましたが、表示を更新できませんでした。再送せず、記録の再確認をしてください。" :
        "記録を保存できませんでした。対象とログイン状態を確認し、新規作成操作を繰り返さないでください。");
    } finally { setPending(false); }
  }

  return <section className="max-w-2xl space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-[13px] text-gray-800">
    <h2 className="font-bold">B005757 非公開テスト登録の記録</h2>
    <p>店舗 evkhihBFFNn5hukMS9s36H ／ 管理コード B005757-TEST-20261004-caf445ac6e676343 ／ 98,000円。BELLOからShopsへ商品送信はしません。</p>
    <p>先にPCの一回限りの試行マーカーを作り、その記録をここへ保存してください。BELLOで保存済みと確認できるまで、Shopsで画像選択・非公開保存を行わないでください。</p>
    <p>試行マーカー: <strong>{trial?.claim ? `保存済み（${trial.claim.recordedAt}）` : "未保存"}</strong></p>
    {trial?.claim && <p>試行ID: <code>{trial.claim.attemptId}</code></p>}
    <label className="block">PCの試行マーカーファイル（JSON）
      <input type="file" accept=".json,application/json" onChange={event =>
        setClaimFile(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" />
    </label>
    <button type="button" disabled={pending || trial === null || !claimFile ||
      Boolean(trial.claim) || acceptedKind === "BELLO_PRIVATE_CREATE_CLAIM"}
      onClick={() => void submit("BELLO_PRIVATE_CREATE_CLAIM", claimFile)}
      className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">試行マーカーをBELLOへ保存</button>
    <div className="border-t border-amber-200 pt-3">
      <p>通常画面の操作後、PCに保存した「通信未確認」の結果だけを報告します。画面上の表示をHTTP作成成功や出品完了に読み替えません。</p>
      <p className="mt-2">結果: <strong>{trial?.result ?
        `通信未確認（${trial.result.recordedAt}）` : "未報告"}</strong></p>
      <label className="mt-2 block">PCの通信未確認結果ファイル（JSON）
        <input type="file" accept=".json,application/json" onChange={event =>
          setResultFile(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" />
      </label>
      <button type="button" disabled={pending || !trial?.claim || !resultFile ||
        Boolean(trial?.result) || acceptedKind === "BELLO_PRIVATE_CREATE_UI_ATTEMPT"}
        onClick={() => void submit("BELLO_PRIVATE_CREATE_UI_ATTEMPT", resultFile)}
        className="mt-2 rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">通信未確認の結果をBELLOへ記録</button>
    </div>
    {message && <p role="status">{message}</p>}
    <p className="text-xs">結果が不明でも新規作成を再実行しません。商品ID・非公開状態・画像・価格は、別の正確な商品読取で確認します。</p>
  </section>;
}
