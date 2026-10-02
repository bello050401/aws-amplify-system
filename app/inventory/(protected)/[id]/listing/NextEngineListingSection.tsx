"use client";

import { useEffect, useState } from "react";
import { clearFailedNextEngineMasterSyncAction, listNextEngineSuppliersAction, readNextEngineMasterSyncAction,
  refreshNextEngineMasterSyncAction, startNextEngineMasterSyncAction } from "@/app/actions/nextEngineMasterSync";
import { previewNextEngineStockAction, type NextEngineStockPreviewResult } from "@/app/actions/nextEngineStockPreview";
import { checkNextEnginePrivatePageAction, type NextEnginePrivatePageCheckResult } from "@/app/actions/nextEnginePrivatePageCheck";
import type { MasterSyncView, NextEngineSupplierChoice } from "@/lib/listing/nextEngine/masterSync";

const statusLabel: Record<MasterSyncView["status"], string> = {
  RESERVED: "送信準備中", UNKNOWN: "結果の確認が必要", QUEUED: "NEが受付済み",
  WAITING: "NEで処理待ち", PROCESSING: "NEで処理中", FAILED: "NEで取込失敗",
  MASTER_APPLIED: "取込済み・内容確認中", MASTER_CONFIRMED: "NE商品マスタの基本項目を確認済み",
};

export function NextEngineListingSection({ inventoryId, title, description, price, imageCount, hasDraft,
  savedMatches, canSend, uploadEnabled, initialSync }: {
  inventoryId: string; title: string; description: string; price: string; imageCount: number;
  hasDraft: boolean; savedMatches: boolean; canSend: boolean; uploadEnabled: boolean; initialSync: MasterSyncView | null;
}) {
  const [sync, setSync] = useState(initialSync);
  const [supplierCode, setSupplierCode] = useState("");
  const [suppliers, setSuppliers] = useState<NextEngineSupplierChoice[] | null>(null);
  const [supplierError, setSupplierError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stockPreview, setStockPreview] = useState<NextEngineStockPreviewResult | null>(null);
  const [stockBusy, setStockBusy] = useState(false);
  const [pageCheck, setPageCheck] = useState<NextEnginePrivatePageCheckResult | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const count = (value: string) => Array.from(value.trim()).length;
  const checks = [
    { label: "商品名", ready: count(title) > 0 && count(title) <= 130, detail: `${count(title)} / 130文字` },
    { label: "商品説明", ready: count(description) > 0 && count(description) <= 3000, detail: `${count(description)} / 3,000文字` },
    { label: "販売価格", ready: price.trim() !== "" && Number.isSafeInteger(Number(price)) && Number(price) >= 300 && Number(price) <= 9999999, detail: "300〜9,999,999円" },
    { label: "画像", ready: imageCount > 0 && imageCount <= 20, detail: `${imageCount} / 20枚` },
  ];
  useEffect(() => {
    if (!canSend || !uploadEnabled || sync) return;
    let active = true;
    void listNextEngineSuppliersAction().then(result => {
      if (!active) return;
      if (!result.ok) { setSupplierError(true); return; }
      setSuppliers(result.suppliers);
      if (result.suppliers.length === 1) setSupplierCode(result.suppliers[0].code);
    }).catch(() => { if (active) setSupplierError(true); });
    return () => { active = false; };
  }, [canSend, uploadEnabled, sync]);
  async function start() {
    if (busy || sync) return;
    setStockPreview(null); setPageCheck(null);
    setBusy(true); setMessage(null);
    try {
      const result = await startNextEngineMasterSyncAction(inventoryId, supplierCode.trim());
      if (result.ok) setSync(result.value);
      else {
        setMessage(result.message);
        const latest = await readNextEngineMasterSyncAction(inventoryId);
        if (latest.ok) setSync(latest.value);
      }
    } catch {
      setMessage("NEの結果を確認できません。再送信せず、状態を確認してください。");
      try {
        const latest = await readNextEngineMasterSyncAction(inventoryId);
        if (latest.ok) setSync(latest.value);
      } catch { /* Server-side reservation still prevents a second upload. */ }
    }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (busy) return;
    setStockPreview(null); setPageCheck(null);
    setBusy(true); setMessage(null);
    try {
      const result = await refreshNextEngineMasterSyncAction(inventoryId);
      if (result.ok) setSync(result.value);
      else setMessage(result.message);
    } catch { setMessage("NEの状態を確認できませんでした。"); }
    finally { setBusy(false); }
  }
  async function clearFailed() {
    if (busy) return;
    setStockPreview(null); setPageCheck(null);
    setBusy(true); setMessage(null);
    try {
      const result = await clearFailedNextEngineMasterSyncAction(inventoryId);
      if (result.ok) setSync(null);
      else setMessage(result.message);
    } catch { setMessage("失敗記録を確認できませんでした。"); }
    finally { setBusy(false); }
  }
  async function previewStock() {
    if (stockBusy) return;
    setStockBusy(true); setStockPreview(null);
    try { setStockPreview(await previewNextEngineStockAction(inventoryId)); }
    catch { setStockPreview({ ok: false, message: "NEの在庫数を確認できませんでした。" }); }
    finally { setStockBusy(false); }
  }
  async function checkPrivatePage() {
    if (pageBusy) return;
    setPageBusy(true); setPageCheck(null);
    try { setPageCheck(await checkNextEnginePrivatePageAction(inventoryId)); }
    catch { setPageCheck({ ok: false, message: "NEの商品ページを確認できませんでした。" }); }
    finally { setPageBusy(false); }
  }
  return (
    <section aria-labelledby="next-engine-heading" className="mt-4 rounded border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="next-engine-heading" className="text-sm font-bold text-gray-900">ネクストエンジンへの商品情報連携</h2>
        <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">{sync ?
          sync.connectionMatches ? statusLabel[sync.status] : "接続先の確認が必要" : "未送信"}</span>
      </div>
      <p className="mt-2 text-xs text-gray-600">保存済みの下書きをNEの商品マスタに登録します。商品ページ・画像の設定とメルカリShopsへの出品はNE側で行います。</p>
      <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        {checks.map(check => <li key={check.label} className="flex items-center justify-between gap-2 rounded bg-gray-50 p-2">
          <span>{check.label} <span className={check.ready ? "text-green-700" : "text-amber-800"}>{check.ready ? "入力済み" : "要確認"}</span></span>
          <span className="text-gray-500">{check.detail}</span>
        </li>)}
      </ul>
      {sync ? <div className="mt-3 space-y-2 text-xs">
        <p>商品コード: {sync.sku}{sync.queueId ? ` ／ NE受付番号: ${sync.queueId}` : ""}</p>
        {!sync.connectionMatches && <p className="text-amber-800">この送信履歴の接続先を現在のNE接続と照合できません。NE側で確認し、再送信しないでください。</p>}
        {sync.connectionMatches && !sync.currentMatches && <p className="text-amber-800">NEへ送った時点とBELLOの下書き・出品設定が異なります。現在の内容を確認してください。</p>}
        {sync.lastError && <p className="text-amber-800">{sync.lastError}</p>}
        <button type="button" className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50" disabled={busy}
          onClick={() => void refresh()}>{busy ? "確認中…" : "NEの処理結果を確認"}</button>
        {sync.status === "FAILED" && sync.connectionMatches && canSend && <button type="button" className="ml-2 rounded border border-amber-400 px-3 py-2 text-amber-900 disabled:opacity-50"
          disabled={busy} onClick={() => void clearFailed()}>失敗を確認して再準備</button>}
        {canSend && sync.status === "MASTER_CONFIRMED" && sync.connectionMatches && sync.currentMatches && <div className="mt-3 rounded border border-gray-200 p-3">
          <p className="font-medium">在庫数の照合（表示のみ）</p>
          <p className="mt-1 text-gray-600">BELLOとNEの数値を比較します。在庫数は変更しません。</p>
          <button type="button" className="mt-2 rounded border border-gray-300 px-3 py-2 disabled:opacity-50"
            disabled={stockBusy} onClick={() => void previewStock()}>{stockBusy ? "確認中…" : "NEの在庫数と比較"}</button>
          {stockPreview && <div role="status" className="mt-2">
            {!stockPreview.ok ? <p className="text-amber-800">{stockPreview.message}</p> :
              stockPreview.comparison ? <p>BELLO: {stockPreview.comparison.belloQuantity}点 ／ NE在庫: {stockPreview.comparison.nextEngineQuantity}点
                （引当: {stockPreview.comparison.nextEngineAllocatedQuantity}点、フリー: {stockPreview.comparison.nextEngineFreeQuantity}点）
                ／ フリー在庫との差: {stockPreview.comparison.freeQuantityDifference > 0 ? "+" : ""}{stockPreview.comparison.freeQuantityDifference}点</p> :
                <p>NEにこの商品コードの在庫記録がありません。</p>}
          </div>}
        </div>}
        {canSend && sync.sku === "B005788" && sync.status === "MASTER_CONFIRMED" && sync.connectionMatches && sync.currentMatches &&
          <div className="mt-3 rounded border border-gray-200 p-3">
            <p className="font-medium">検証商品のNEページ公開状態</p>
            <p className="mt-1 text-gray-600">NEの商品ページを読み取ります。メルカリShopsへの出品状態は別に確認が必要です。</p>
            <button type="button" className="mt-2 rounded border border-gray-300 px-3 py-2 disabled:opacity-50"
              disabled={pageBusy} onClick={() => void checkPrivatePage()}>{pageBusy ? "確認中…" : "NEページの非公開状態を確認"}</button>
            {pageCheck && <p role="status" className="mt-2 text-amber-800">
              {!pageCheck.ok ? pageCheck.message : pageCheck.visibility === "PRIVATE" ? "読み取り時点でNEの商品ページは非公開（0）です。メルカリShops側の非公開は未確認です。" :
                pageCheck.visibility === "MISSING" ? "NEの商品ページはまだありません。" :
                pageCheck.visibility === "PUBLIC" ? "NEの商品ページは公開（1）です。非公開テストには使えません。" :
                "NEの商品ページの公開状態を判定できません。"}
            </p>}
          </div>}
      </div> : canSend && uploadEnabled && <div className="mt-3 space-y-2 text-xs">
        <label className="block">NEに登録済みの仕入先コード
          {suppliers ? <select value={supplierCode} onChange={event => setSupplierCode(event.target.value)}
            className="mt-1 block w-full max-w-xs rounded border border-gray-300 px-3 py-2">
            <option value="">仕入先を選択</option>
            {suppliers.map(supplier => <option key={supplier.code} value={supplier.code}>{supplier.name}（{supplier.code}）</option>)}
          </select> : <p className="mt-1 text-gray-600">{supplierError ? "仕入先を取得できませんでした。NEの接続を確認してください。" : "仕入先を読み込み中…"}</p>}
        </label>
        <button type="button" className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50"
          disabled={busy || !hasDraft || !savedMatches || !supplierCode.trim() || !checks.every(check => check.ready)}
          onClick={() => void start()}>{busy ? "NEへ送信中…" : "NEの商品マスタへ登録"}</button>
        {!savedMatches && <p className="text-amber-800">画面の変更を保存してから送信してください。</p>}
      </div>}
      {!sync && canSend && !uploadEnabled && <p className="mt-3 text-xs text-amber-800">NEへの通常商品送信は設定待ちです。</p>}
      {message && <p role="status" className="mt-2 text-xs text-amber-800">{message}</p>}
      <p className="mt-3 text-xs text-gray-600">登録結果が不明な場合は再送しません。商品マスタ登録だけではメルカリShopsに出品されません。</p>
      <a href="https://base.next-engine.org/" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded border border-gray-300 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">ネクストエンジンを開く</a>
    </section>
  );
}
