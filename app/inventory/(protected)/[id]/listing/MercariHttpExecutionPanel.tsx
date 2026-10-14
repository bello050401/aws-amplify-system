"use client";
import { useEffect, useState } from "react";
import { getMercariHttpListingStateAction, publishMercariHttpListingAction,
  stopMercariHttpListingAction, reopenMercariHttpListingAction, renewMercariHttpConnectionAction,
  type HttpListingState } from "@/app/actions/mercariWebHttpLifecycle";
import type { PublishPreview } from "@/lib/listing/mercariBridge/webHttpProductPublish";
import { executeMercariHttpDraftStepAction } from "@/app/actions/mercariWebHttpExecuteDraft";

const labels: Record<HttpListingState["status"], string> = {
  FORBIDDEN: "操作できる権限がありません", NOT_CONFIGURED: "HTTPS実行環境の反映待ちです",
  AUTH_REQUIRED: "メルカリShopsの再認証が必要です", UNAVAILABLE: "接続または結果を確認できません",
  VERIFY_REQUIRED: "前回の操作結果を確認中です。状態の確認で再送せずに照合します。",
  NOT_PREPARED: "出品内容を入力してください", PREPARED: "準備登録済み・Shops下書きは未保存です",
  DRAFT_READY: "下書き保存済み・出品内容を確認できます", LISTED: "出品中", STOPPED: "出品停止中",
};
export function MercariHttpExecutionPanel({ inventoryId, requestId, onDraftSaved }: {
  inventoryId: string; requestId: string | null; onDraftSaved?: () => void }) {
  const [state, setState] = useState<HttpListingState | null>(null);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [savingDraft, setSavingDraft] = useState(false);
  useEffect(() => {
    let active = true;
    setState(null); setPreview(null); setSavingDraft(false);
    void getMercariHttpListingStateAction(inventoryId).then(value => { if (active) setState(value); })
      .catch(() => { if (active) setMessage("接続状態を取得できませんでした。"); });
    return () => { active = false; };
  }, [inventoryId, requestId]);
  useEffect(() => {
    const tick = () => setSeconds(waitUntil ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0);
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [waitUntil]);
  useEffect(() => {
    if (!savingDraft || !requestId) return;
    let active = true;
    setBusy(true);
    void (async () => {
      try {
        for (let step = 0; step < 30 && active; step++) {
          const value = await executeMercariHttpDraftStepAction(requestId);
          if (!active) return;
          setWaitUntil(value.nextEligibleAtMs);
          if (value.status === "CONTINUE" || value.status === "WAIT_INTERVAL") {
            if (!value.nextEligibleAtMs) throw Error("Missing send window");
            setMessage("Shopsの下書き保存を進めています。次の送信まで間隔を空けます。");
            await new Promise(resolve => setTimeout(resolve, Math.max(1000, value.nextEligibleAtMs! - Date.now() + 500)));
            continue;
          }
          setMessage(value.status === "DRAFT_READY" ? "Shopsに下書きを保存し、内容を確認しました。" :
            value.status === "AUTH_REQUIRED" ? "認証期限が切れました。再認証後に保存処理を再開できます。" :
            value.status === "UNSUPPORTED_SELECTION" ? "選択された商品条件はまだ送信検証が完了していません。" :
            value.status === "SOURCE_CHANGED" ? "EC下書きまたは在庫の内容が変わりました。確認してください。" :
            "保存結果を確認できません。送信済みの処理は繰り返しません。");
          const latest = await getMercariHttpListingStateAction(inventoryId);
          if (active) {
            setState(latest);
            if (value.status === "DRAFT_READY") onDraftSaved?.();
          }
          return;
        }
        if (active) setMessage("保存処理を中断しました。状態を確認してください。");
      } catch { if (active) setMessage("結果を取得できません。状態を確認してください。"); }
      finally { if (active) { setBusy(false); setSavingDraft(false); } }
    })();
    return () => { active = false; };
  }, [savingDraft, requestId, inventoryId, onDraftSaved]);
  async function act(operation: "check" | "renew" | "review" | "publish" | "stop") {
    if (busy || seconds > 0) return;
    setBusy(true); setMessage("");
    try {
      if (operation === "renew") {
        setPreview(null);
        const connection = await renewMercariHttpConnectionAction();
        setMessage(connection === "CONNECTED" ? "接続を確認しました。商品は変更していません。" :
          connection === "AUTH_REQUIRED" ? "接続を更新できませんでした。メルカリShopsへの再ログインが必要です。" :
          "接続を確認できません。しばらくしてから状態を確認してください。");
        setState(await getMercariHttpListingStateAction(inventoryId));
        return;
      }
      if (operation === "check") { setPreview(null); setState(await getMercariHttpListingStateAction(inventoryId)); return; }
      if (operation === "stop") {
        const result = await stopMercariHttpListingAction(inventoryId);
        setWaitUntil(result.nextEligibleAtMs);
        setMessage(result.stopConfirmed ? "出品停止を確認し、保存しました。" :
          result.status === "WAIT_INTERVAL" ? "前の送信からの間隔を空けています。" :
          result.status === "AUTH_REQUIRED" ? "再認証が必要です。" : "停止結果を確認できません。状態を再確認してください。");
        if (result.stopConfirmed) setState(await getMercariHttpListingStateAction(inventoryId));
      } else {
        const execute = state?.status === "STOPPED" ? reopenMercariHttpListingAction : publishMercariHttpListingAction;
        const result = await execute(inventoryId, operation === "publish" ? preview?.digest ?? "" : null);
        setWaitUntil(result.nextEligibleAtMs); setPreview(result.preview);
        setMessage(result.status === "PUBLISHED" ? "出品を確認し、商品との紐付けを保存しました。" :
          result.status === "READY_FOR_CONFIRMATION" ? "下の内容で公開します。内容をご確認ください。" :
          result.status === "CONFIRMATION_CHANGED" ? "内容が変わりました。確認し直してください。" :
          result.status === "WAIT_INTERVAL" ? "前の送信からの間隔を空けています。" :
          result.status === "AUTH_REQUIRED" ? "再認証が必要です。" :
          result.status === "DRAFT_UNVERIFIED" ? "Shops下書きと保存済みの出品内容を照合できませんでした。今回の公開送信は行っていません。" :
          result.status === "SOURCE_CHANGED" ? "EC下書きまたは在庫の内容が変わりました。今回の公開送信は行っていません。" :
          result.status === "VALIDATION_FAILED" ? "Shopsが商品内容の確認を受け付けませんでした。今回の公開送信は行っていません。" :
          "出品結果または準備内容を確認できません。重複防止のため自動再送は行いません。");
        if (result.status === "PUBLISHED" || result.status === "EXISTING_PRODUCT") setState(await getMercariHttpListingStateAction(inventoryId));
      }
    } catch { setPreview(null); setMessage("結果を取得できません。状態を確認してください。"); }
    finally { setBusy(false); }
  }
  return <div className="my-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
    <p role="status" className="font-semibold">{state ? labels[state.status] : "HTTPS接続を確認中…"}</p>
    {state?.authenticatedUntil && <p className="mt-1 text-xs">接続の有効期限: {new Date(state.authenticatedUntil).toLocaleString("ja-JP")}（利用時に自動更新）</p>}
    {state?.productId && <a className="mt-1 block text-blue-700 underline" target="_blank" rel="noreferrer"
      href={`https://mercari-shops.com/seller/shops/evkhihBFFNn5hukMS9s36H/products/${state.productId}/edit`}>Shopsの商品を開く</a>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy || seconds > 0}
        onClick={() => void act("check")}>状態を確認</button>
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy || seconds > 0}
        onClick={() => void act("renew")}>接続を更新</button>
      {(state?.status === "DRAFT_READY" || state?.status === "STOPPED") && <button type="button" className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50"
        disabled={busy || seconds > 0} onClick={() => void act("review")}>出品内容を確認</button>}
      {state?.status === "PREPARED" && <button type="button" className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50"
        disabled={busy || savingDraft || seconds > 0} onClick={() => setSavingDraft(true)}>Shopsに下書きを保存</button>}
      {state?.status === "LISTED" && <button type="button" className="rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50"
        disabled={busy || seconds > 0} onClick={() => void act("stop")}>出品停止</button>}
    </div>
    {state?.status === "STOPPED" && <p className="mt-2 text-xs">再出品では、同じShops商品を公開に戻します。</p>}
    {preview && <div className="mt-3 rounded border bg-white p-3">
      <p className="font-semibold">{preview.title}</p>
      <p>販売価格 ¥{preview.priceYen.toLocaleString("ja-JP")}・数量 {preview.quantity}・写真 {preview.imageCount} 枚</p>
      <button type="button" disabled={busy || seconds > 0} className="mt-2 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50"
        onClick={() => void act("publish")}>この内容で出品する</button>
    </div>}
    {seconds > 0 && <p className="mt-2">次の送信まで {seconds} 秒</p>}
    {message && <p role="status" className="mt-2">{message}</p>}
  </div>;
}
