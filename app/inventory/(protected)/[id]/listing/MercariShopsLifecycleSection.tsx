"use client";

import { useRef, useState } from "react";
import { prepareMercariVisibilityPcJobAction } from "@/app/actions/mercariVisibilityHandoff";
import type { ChannelListingRecord } from "@/lib/listing/types";
import { shopsAdminUrl, shopsLifecycle,
  type ShopsOperation } from "@/lib/listing/mercariBridge/listingLifecycle";
import { pcTargetKey, pcRecordCurrent, pcVisibilityControl,
  pinnedPublicProofForTarget, samePcTargetEpoch,
  type PcVisibilityStatus, type PinnedPublicProof } from
  "@/lib/listing/mercariBridge/lifecyclePcState";

const SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const LABEL = {
  NOT_LISTED: "BELLO出品記録なし", CREATING: "出品処理中", LISTED: "出品済み（BELLO記録）",
  STOPPING: "停止処理中", STOPPED: "停止済み（BELLO記録）",
  PRIVATE: "非公開（BELLO記録）", UNKNOWN: "結果の確認が必要",
} as const;
/** The PC app accepts a prepared job; its explicit local action performs the transition. */
export function MercariShopsLifecycleSection({ inventoryId, listing, operation = null,
  canPrepare = false }: {
  inventoryId: string;
  listing: ChannelListingRecord | null;
  operation?: ShopsOperation | null;
  canPrepare?: boolean;
}) {
  const targetKey = pcTargetKey(inventoryId, listing?.externalListingId);
  const targetEpoch = useRef({ key: targetKey, value: 0 });
  if (targetEpoch.current.key !== targetKey)
    targetEpoch.current = { key: targetKey, value: targetEpoch.current.value + 1 };
  const started = { ...targetEpoch.current };
  const isCurrent = () => samePcTargetEpoch(targetEpoch.current, started);
  const [busyRecord, setBusyRecord] = useState({ key: targetKey, epoch: started.value,
    value: false });
  const busy = pcRecordCurrent(busyRecord, started) && busyRecord.value;
  const [preparedRecord, setPreparedRecord] = useState<{
    key: string; epoch: number; actions: ReadonlySet<"STOP" | "RELIST"> }>({
    key: targetKey, epoch: started.value, actions: new Set() });
  const preparedActions = pcRecordCurrent(preparedRecord, started) ?
    preparedRecord.actions : new Set<"STOP" | "RELIST">();
  const [pcRecord, setPcRecord] = useState<{
    key: string; epoch: number; status: PcVisibilityStatus;
    proof: PinnedPublicProof | null }>({
    key: targetKey, epoch: started.value, status: "UNREAD", proof: null });
  const pcStatus = pcRecordCurrent(pcRecord, started) ?
    pcRecord.status : "UNREAD";
  const [messageRecord, setMessageRecord] = useState({ key: targetKey,
    epoch: started.value,
    value: null as string | null });
  const message = pcRecordCurrent(messageRecord, started) ?
    messageRecord.value : null;
  const pinnedProof = pinnedPublicProofForTarget(pcRecordCurrent(pcRecord, started) ?
    pcRecord : { key: "", status: "UNREAD", proof: null },
    inventoryId, listing?.externalListingId);
  const publicProof = pinnedProof ?
    { kind: "EXACT_PRODUCT" as const, remoteId: pinnedProof.remoteId,
      visibility: "PUBLIC" as const } : null;
  const state = shopsLifecycle(listing, operation, publicProof);
  const url = listing && state !== "NOT_LISTED" ?
    shopsAdminUrl(SHOP_ID, listing.externalListingId) : null;
  const pcFeatureEnabled = process.env.NEXT_PUBLIC_MERCARI_VISIBILITY_PC_JOB_ENABLED === "1" &&
    operation === null && listing?.status === "ACTIVE" && Boolean(url) &&
    inventoryId.toLowerCase() !== "dd273c1e-9b2a-4013-acc6-c445a481fab8";
  const stopHandoffEnabled = pcFeatureEnabled && publicProof !== null;
  // The Shops public relist UI still needs read-only observation.
  const control = pcVisibilityControl(pcFeatureEnabled, pcStatus,
    stopHandoffEnabled, false);
  async function prepareHandoff(action: "STOP" | "RELIST") {
    if (action !== control.action || !control.enabled || busy ||
        preparedActions.has(action)) return;
    const remoteId = listing?.externalListingId;
    if (!remoteId) return;
    setBusyRecord({ key: targetKey, epoch: started.value, value: true });
    setMessageRecord({ key: targetKey, epoch: started.value, value: null });
    try {
      const result = await prepareMercariVisibilityPcJobAction(inventoryId, action);
      if (!isCurrent()) return;
      if (!result.ok) { setMessageRecord({ key: targetKey, epoch: started.value,
        value: result.message }); return; }
      if (result.job.target.inventoryId.toLowerCase() !== inventoryId.toLowerCase() ||
          result.job.target.remoteId !== remoteId ||
          result.job.target.shopId !== SHOP_ID || result.job.action !== action)
        throw Error("PC job target mismatch");
      try {
        const response = await fetch("http://127.0.0.1:56210/visibility-job", {
          method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json",
            "x-bello-mercari-bridge": "VISIBILITY_JOB" },
          body: JSON.stringify(result.job), signal: AbortSignal.timeout(4000),
        });
        const receipt = response.ok ? await response.json() : null;
        if (!isCurrent()) return;
        if (receipt?.ok === true && /^[a-f0-9]{64}$/.test(receipt.jobKey) &&
            ["QUEUED_NO_SEND", "ALREADY_QUEUED_NO_SEND"].includes(receipt.status)) {
          setPreparedRecord(previous => ({ key: targetKey, epoch: started.value,
            actions: new Set(previous.key === targetKey &&
              previous.epoch === started.value ? previous.actions : []).add(action) }));
          setMessageRecord({ key: targetKey, epoch: started.value,
            value: "PCアプリへ依頼を渡しました。PC画面で対象を確認して実行してください。Shopsの商品はまだ変更していません。" });
          return;
        }
      } catch { /* PC app may be closed; a local file is the explicit fallback. */ }
      if (!isCurrent()) return;
      const blob = new Blob([JSON.stringify(result.job, null, 2) + "\n"],
        { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `bello-shops-${action.toLowerCase()}-${result.job.target.skuCode}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setPreparedRecord(previous => ({ key: targetKey, epoch: started.value,
        actions: new Set(previous.key === targetKey &&
          previous.epoch === started.value ? previous.actions : []).add(action) }));
      setMessageRecord({ key: targetKey, epoch: started.value,
        value: "PCアプリに接続できなかったため、ジョブファイルを保存しました。PCアプリで読み込むまでShopsの商品は変更されません。" });
    } catch { if (isCurrent()) setMessageRecord({ key: targetKey, epoch: started.value,
      value: "PC作業用ジョブを準備できませんでした。Shopsの商品は変更していません。" }); }
    finally { if (isCurrent()) setBusyRecord({ key: targetKey,
      epoch: started.value, value: false }); }
  }
  async function checkPcStatus() {
    if (!pcFeatureEnabled || busy || !listing?.externalListingId) return;
    const remoteId = listing.externalListingId;
    setBusyRecord({ key: targetKey, epoch: started.value, value: true });
    setMessageRecord({ key: targetKey, epoch: started.value, value: null });
    try {
      const response = await fetch(`http://127.0.0.1:56210/visibility-status?inventoryId=${encodeURIComponent(inventoryId)}`, {
        mode: "cors", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const payload = response.ok ? await response.json() : null;
      if (!isCurrent()) return;
      if (payload?.ok !== true || !Array.isArray(payload.items) ||
          payload.items.some((item: { remoteId?: string }) =>
            item.remoteId !== remoteId))
        throw Error("PC result mismatch");
      const stop = payload.items.find((item: { action?: string }) => item.action === "STOP");
      const relist = payload.items.find((item: { action?: string }) => item.action === "RELIST");
      const publicProof = payload.publicProof;
      if (publicProof !== null && publicProof !== undefined &&
          (publicProof.status !== "PUBLIC_CONFIRMED" ||
            publicProof.remoteId !== remoteId ||
            !Number.isFinite(Date.parse(publicProof.observedAt))))
        throw Error("PC public proof mismatch");
      const proof = publicProof?.status === "PUBLIC_CONFIRMED" ?
        { inventoryId, remoteId, observedAt: publicProof.observedAt } : null;
      let status: PcVisibilityStatus;
      if (relist?.outcome === "RELIST_VERIFIED") status = "RELIST_VERIFIED";
      else if (stop?.outcome === "STOP_VERIFIED" &&
          (!relist?.attempted || relist?.outcome === null))
        status = relist?.attempted ? "UNKNOWN" : "STOP_VERIFIED";
      else if (stop?.attempted || relist?.attempted) status = "UNKNOWN";
      else if (proof) status = "PUBLIC_VERIFIED";
      else status = "PENDING";
      setPcRecord({ key: targetKey, epoch: started.value, status, proof });
      setMessageRecord({ key: targetKey, epoch: started.value,
        value: "PCの保存済み結果を読み取りました。Shopsへの操作はしていません。" });
    } catch { if (isCurrent()) setMessageRecord({ key: targetKey, epoch: started.value,
      value: "PCの結果を確認できませんでした。PCアプリを開いて確認してください。" }); }
    finally { if (isCurrent()) setBusyRecord({ key: targetKey,
      epoch: started.value, value: false }); }
  }
  return <section aria-labelledby="mercari-shops-lifecycle-heading"
    className="mt-4 rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="mercari-shops-lifecycle-heading" className="font-bold">メルカリShops</h2>
      <span className="rounded bg-gray-100 px-2 py-1 text-xs">{pcStatus === "PUBLIC_VERIFIED" ?
        "公開確認済み（PC読取）" : pcStatus === "STOP_VERIFIED" ?
        "停止確認済み（PC読取）" : pcStatus === "RELIST_VERIFIED" ?
          "再出品確認済み（PC読取）" : pcStatus === "UNKNOWN" ?
          "PC結果の確認が必要" : state === "UNKNOWN" && listing?.status === "ACTIVE" ?
            "Shops公開状態の確認待ち" : LABEL[state]}</span>
    </div>
    {listing?.externalListingId && url && <p className="mt-2 text-xs">
      商品ID: <code>{listing.externalListingId}</code> ／ <a href={url}
        target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">商品管理画面</a>
    </p>}
    {state === "NOT_LISTED" && canPrepare && !listing && ![
      "dd273c1e-9b2a-4013-acc6-c445a481fab8",
      "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
    ].includes(inventoryId.toLowerCase()) ? <a href="#mercari-manual-preparation"
      className="mt-3 inline-block rounded border border-gray-300 px-3 py-2 text-xs font-bold">
      出品準備へ
    </a> : <button type="button"
      disabled={!control.enabled || busy ||
        (control.action !== null && preparedActions.has(control.action))}
      aria-disabled={!control.enabled || busy ||
        (control.action !== null && preparedActions.has(control.action))}
      onClick={() => { if (control.action) void prepareHandoff(control.action); }}
      className="mt-3 rounded border border-gray-300 px-3 py-2 text-xs font-bold disabled:opacity-50">
      {busy ? "準備中…" : control.action && preparedActions.has(control.action) ?
        "PCジョブを保存済み" : pcFeatureEnabled ? control.label :
          state === "NOT_LISTED" ? "出品" : "Shops公開状態の確認待ち"}
    </button>}
    {pcFeatureEnabled && <button type="button" disabled={busy}
      onClick={() => void checkPcStatus()}
      className="ml-2 mt-3 rounded border border-gray-300 px-3 py-2 text-xs font-bold disabled:opacity-50">
      PCの結果を確認
    </button>}
    {(pcStatus === "STOP_VERIFIED" || pcStatus === "RELIST_VERIFIED") &&
      <a href="/inventory/listings"
        className="ml-2 mt-3 inline-block rounded border border-gray-300 px-3 py-2 text-xs font-bold">
        EC出品一覧に戻る
      </a>}
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}
    <p className="mt-2 text-xs text-gray-600">{pcStatus === "STOP_VERIFIED" ?
      "停止はPCで確認済みです。再出品はShopsの公開操作を確認するまで利用できません。" :
      state === "UNKNOWN" ?
      "Shops側の結果を確認するまで再操作できません。" :
      state === "CREATING" || state === "STOPPING" ?
        "Shops側の結果を確認中です。重複操作を防ぐため再操作できません。" :
        pcFeatureEnabled ? "PC側で対象IDと公開状態を再確認します。再出品は同じ商品の停止完了記録がある場合のみ行えます。" :
        "BELLOに記録がなくてもShops側に既存商品がある場合があります。画面操作と結果確認を接続するまで、このボタンは実行できません。"}</p>
  </section>;
}
