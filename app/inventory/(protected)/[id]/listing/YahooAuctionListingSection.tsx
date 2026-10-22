"use client";

import { EcPresetPicker } from "../../listings/EcPresetPicker";
import { presetDescription, presetEndAt } from "@/lib/listing/ecPresets";
import { useEffect, useRef, useState } from "react";
import { YahooAuctionControls, yahooWorkflowMessage } from "./YahooAuctionControls";
import { searchYahooCategoriesAction } from "@/app/actions/yahooAuctionWorkflow";
import { getYahooAuctionPreparationAction, saveYahooAuctionPreparationAction } from "@/app/actions/yahooAuctionPreparation";
import { checkYahooHttpsConnectionAction } from "@/app/actions/yahooAuctionHttp";
import type { YahooListingResult } from "@/lib/listing/yahooAuction/listingResult";
import { initialYahooAuctionInput, restoreYahooAuctionInput, yahooPreparationIssues, yahooSourceMatches,
  type YahooAuctionInput, type YahooAuctionSaved } from "@/lib/listing/yahooAuction/preparation";
import { LISTING_CONDITIONS } from "@/lib/listing/conditionOptions";
import { LISTING_SHIPPING_METHODS, type ListingDraftRecord } from "@/lib/listing/types";

const field = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50";
const failureMessage = (code: string) => ({
  FORBIDDEN: "編集権限を確認できません。BELLOにログインし直してください。",
  INVALID_INPUT: "価格・数量・カテゴリーID・終了日時の入力を確認してください。",
  SOURCE_CHANGED: "共通下書きが更新されました。入力は残っています。「共通下書きを確認」を押してから保存してください。",
  CONFLICT: "別の画面でヤフオク下書きが更新されました。入力を控えてからページを再読み込みしてください。",
  NOT_ELIGIBLE: "在庫数または販売状況が変わったため保存できません。商品情報を確認してください。",
  UNAVAILABLE: "保存状態を確認できません。入力は残っています。再読み込み前に入力を控えてください。",
  NOT_CONFIGURED: "ヤフオク接続の設定がまだ完了していません。",
  AUTH_REQUIRED: "ヤフオクのログイン状態を確認できません。認証の更新が必要です。",
  ACCESS_DENIED: "Yahoo!オークションが接続を受け付けませんでした。出品処理は行っていません。",
  RATE_LIMITED: "Yahoo!オークションが一時的に接続を制限しています。時間を空けて確認してください。",
  SESSION_UNAVAILABLE: "ヤフオクの接続情報を読み込めませんでした。",
  RESULT_UNAVAILABLE: "出品結果を確認できません。出品・取消の再送は行っていません。",
  REMOTE_CONTENT_CHANGED: "ヤフオク側の商品情報が変更されています。商品画面を確認してください。",
}[code] ?? "読み込みに失敗しました。もう一度確認してください。");

export function YahooAuctionListingSection({ inventoryId, showExecution = true }: { inventoryId: string; showExecution?: boolean }) {
  const [input, setInput] = useState<YahooAuctionInput>(initialYahooAuctionInput(null));
  const [draft, setDraft] = useState<ListingDraftRecord | null>(null);
  const [saved, setSaved] = useState<YahooAuctionSaved | null>(null);
  const [available, setAvailable] = useState(0);
  const [eligible, setEligible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [connectionCheckedAt, setConnectionCheckedAt] = useState<string | null>(null);
  const [listing, setListing] = useState<YahooListingResult | null>(null);
  const inFlight = useRef(false);
  const [categoryQuery,setCategoryQuery]=useState("");
  const [categories,setCategories]=useState<{id:string;name:string;path:string}[]>([]);

  useEffect(() => {
    let active = true;
    setListing(null);
    getYahooAuctionPreparationAction(inventoryId).then(result => {
      if (!active) return;
      if (!result.ok) { setError(failureMessage(result.code)); return; }
      const c = result.context;
      setDraft(c.draft); setSaved(c.saved); setAvailable(c.availableQuantity); setEligible(c.canPrepare);
      setInput(restoreYahooAuctionInput(c.draft, c.saved)); setLoaded(true);
    }).catch(() => { if (active) setError("ヤフオク下書きを読み込めません。ページを再読み込みしてください。"); });
    return () => { active = false; };
  }, [inventoryId]);

  function change<K extends keyof YahooAuctionInput>(key: K, value: YahooAuctionInput[K]) {
    setInput(old => ({ ...old, [key]: value })); setMessage("");
  }
  async function checkConnection() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage(""); setConnectionCheckedAt(null);
    try {
      const result = await checkYahooHttpsConnectionAction();
      if (!result.ok) { setError(failureMessage(result.code)); return; }
      setConnectionCheckedAt(result.checkedAt);
      setMessage("BELLOのサーバーからヤフオクへの接続を確認しました。出品操作は行っていません。");
    } catch { setError("接続を確認できませんでした。出品操作は行っていません。"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function refreshSource() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await getYahooAuctionPreparationAction(inventoryId);
      if (!result.ok) { setError(failureMessage(result.code)); return; }
      const c = result.context;
      if (loaded && (c.saved?.revision ?? null) !== (saved?.revision ?? null)) {
        setConflict(true); setError(failureMessage("CONFLICT")); return;
      }
      setDraft(c.draft); setAvailable(c.availableQuantity); setEligible(c.canPrepare);
      if (!loaded) { setSaved(c.saved); setInput(restoreYahooAuctionInput(c.draft, c.saved)); setLoaded(true); }
      else if (c.draft && draft) setInput(current => restoreYahooAuctionInput(c.draft, {
        revision: saved?.revision ?? 1, updatedAt: draft.updatedAt,
        payload: { schemaVersion: 1, input: current, source: {
          draftId: draft.id, draftUpdatedAt: draft.updatedAt, images: draft.images, shippingMethod: draft.shippingMethod,
          commonCategoryId: draft.commonCategoryId ?? null, commonPriceYen: draft.channelPrices?.YAHOO ?? draft.price,
        } },
      }));
      setMessage(c.draft ? "最新の共通下書き・写真・配送方法を確認しました。" : "上の共通下書きを先に保存してください。");
    } catch { setError(failureMessage("UNAVAILABLE")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function save() {
    if (!draft || !loaded || conflict || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await saveYahooAuctionPreparationAction(inventoryId, input, saved?.revision ?? null, draft.updatedAt);
      if (!result.ok) { setError(failureMessage(result.code)); if (result.code === "CONFLICT") setConflict(true); return; }
      setSaved(result.saved); setInput(result.saved.payload.input);
      setMessage("ヤフオク用の下書きをBELLOに保存しました。出品状況は上の表示で確認できます。");
    } catch { setError(failureMessage("UNAVAILABLE")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const issues = yahooPreparationIssues(input, draft?.images.length ?? 0, available);
  const sourceChanged = saved && draft && !yahooSourceMatches(saved.payload.source, draft);
  return <section id="yahoo-auction-listing" className="mt-5 max-w-2xl rounded border bg-white p-4 xl:max-w-4xl">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold">ヤフオク出品</h2>
      <span className="rounded bg-gray-100 px-2 py-1 text-xs">個人アカウント</span>
    </div>
    {listing && <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
      <p className="font-semibold">{listing.remoteStatus==='open'?'出品中':listing.remoteStatus==='cancelled'?'出品停止中':'終了'}（確認時点）</p>
      <p className="mt-1">{listing.priceYen.toLocaleString('ja-JP')}円・数量{listing.quantity}・入札{listing.bids}件</p>
      <p className="mt-1 text-xs">確認：{new Date(listing.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>
      <a className="mt-1 inline-block text-blue-700 underline" href={`https://auctions.yahoo.co.jp/jp/auction/${listing.auctionId}`} target="_blank" rel="noreferrer">ヤフオクの商品を開く</a>
    </div>}
    {showExecution && <YahooAuctionControls inventoryId={inventoryId} revision={saved?.revision??null}
      dirty={!saved||JSON.stringify(input)!==JSON.stringify(saved.payload.input)||!!sourceChanged} disabled={busy||!loaded}
      onListing={setListing} />}
    <div className="my-3 flex flex-wrap gap-2">
      {showExecution && <button type="button" disabled={busy} onClick={checkConnection} className="rounded border px-3 py-2 text-sm disabled:opacity-50">ヤフオク接続を確認</button>}
      <button type="button" disabled={busy} onClick={refreshSource} className="rounded border px-3 py-2 text-sm disabled:opacity-50">共通下書きを確認</button>
    </div>
    {error && <p role="alert" className="my-2 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="my-2 text-sm text-green-800">{message}</p>}
    {connectionCheckedAt&&<p className="text-xs text-gray-500">接続確認：{new Date(connectionCheckedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>}
    {!loaded ? <p className="text-sm text-gray-600">{error ? "下書きは未確認です。「共通下書きを確認」で再取得できます。" : "下書きを確認中です。"}</p> : <>
      <p className="text-xs text-gray-600">{saved ? `BELLO保存済み：${new Date(saved.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` : "ヤフオク用の下書きは未保存です。"}</p>
      {!eligible && <p className="mt-2 text-sm text-red-700">この商品の在庫・販売状況では、出品準備を保存できません。</p>}
      {!draft && <p className="mt-2 text-sm text-amber-800">上の共通下書きを保存してから「共通下書きを確認」を押してください。</p>}
      {sourceChanged && <p className="mt-2 text-sm text-amber-800">共通下書きの写真・配送方法が更新されています。次の保存で最新の内容を取り込みます。</p>}
      <p className="mt-3 text-xs text-gray-600">商品名・説明・状態はヤフオク用に編集できます。メルカリやBASEの下書きには影響しません。</p>
      <fieldset disabled={busy || !eligible || conflict} className="mt-3 space-y-4">
        <EcPresetPicker channel="YAHOO" disabled={busy || !draft} onApply={p=>{if(!draft)return;setInput(old=>({...old,format:"FIXED",buyNowYen:null,autoExtension:false,priceYen:draft.price==null?null:draft.price+p.values.priceAddition,shippingMethod:p.values.shippingMethod,endAtJst:presetEndAt(p.values),description:presetDescription(draft.description??"",p.values.descriptionSuffix),...(p.values.categoryId?{categoryId:p.values.categoryId,categoryName:p.values.categoryName}:{})}));setMessage(`「${p.name}」を適用しました。内容を確認して保存してください。`);}}/>
        <button type="button" disabled={!draft} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => {
          if (!draft) return;
          setInput(old => ({ ...old, title: draft.title, description: draft.description ?? "", condition: draft.condition }));
          setMessage("商品名・説明・状態を共通下書きから取り込みました。保存するとヤフオク用の下書きに反映されます。");
        }}>共通下書きの商品情報を使う</button>
        <div><label htmlFor="yahoo-title" className="text-sm">商品名</label>
          <input id="yahoo-title" maxLength={300} className={field} value={input.title} onChange={e => change("title", e.target.value)} />
          <p className="text-right text-xs text-gray-500">{[...input.title].length} / 65文字</p></div>
        <div><label htmlFor="yahoo-description" className="text-sm">商品説明</label>
          <textarea id="yahoo-description" maxLength={30000} className={field} rows={6} value={input.description} onChange={e => change("description", e.target.value)} /></div>
        <div><label htmlFor="yahoo-condition" className="text-sm">商品の状態</label>
          <select id="yahoo-condition" className={field} value={input.condition ?? ""} onChange={e => change("condition", e.target.value as YahooAuctionInput["condition"] || null)}>
            <option value="">選択してください</option>{LISTING_CONDITIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select></div>
        <div><label htmlFor="yahoo-format" className="text-sm">販売形式</label>
          <select id="yahoo-format" className={field} value={input.format} onChange={e => change("format", e.target.value as YahooAuctionInput["format"])}>
            <option value="FIXED">定額（即決価格で販売）</option><option value="AUCTION" disabled>オークション（競り）は未対応</option>
          </select></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="yahoo-price" className="text-sm">{input.format === "FIXED" ? "即決価格（円）" : "開始価格（円）"}</label>
            <input id="yahoo-price" type="number" min={1} step={1} className={field} value={input.priceYen ?? ""} onChange={e => change("priceYen", e.target.value === "" ? null : Number(e.target.value))} />
          </div>
          <div><label htmlFor="yahoo-quantity" className="text-sm">出品数量（共通情報で設定・現在庫 {available}）</label>
            <input id="yahoo-quantity" type="number" readOnly min={1} max={Math.min(9, available)} step={1} className={field} value={input.quantity} onChange={e => change("quantity", Number(e.target.value))} /></div>
        </div>
        <p className="text-xs text-gray-600">送料を含まない商品単価です。送料は配送先に応じて落札後に案内します。数量は出品前に在庫と照合します。</p>
        {input.format === "AUCTION" && <div><label htmlFor="yahoo-buy-now" className="text-sm">即決価格（任意・円）</label>
          <input id="yahoo-buy-now" type="number" min={1} step={1} className={field} value={input.buyNowYen ?? ""} onChange={e => change("buyNowYen", e.target.value === "" ? null : Number(e.target.value))} /></div>}
        <div><label htmlFor="yahoo-category-query" className="text-sm">カテゴリーを検索</label>
          <div className="mt-1 flex gap-2"><input id="yahoo-category-query" className={field} maxLength={100} placeholder="例：ダイニングチェア" value={categoryQuery} onChange={e=>setCategoryQuery(e.target.value)}/>
            <button type="button" disabled={busy||!categoryQuery.trim()} className="shrink-0 rounded border px-3 py-2 text-sm" onClick={async()=>{setBusy(true);setError('');try{const r=await searchYahooCategoriesAction(categoryQuery);if(r.ok){setCategories(r.value);if(!r.value.length)setMessage('一致するカテゴリーがありません。別の言葉で検索してください。');}else setError(yahooWorkflowMessage(r.code));}catch{setError('カテゴリーを読み込めません。');}finally{setBusy(false);}}}>検索</button></div>
          {categories.length>0&&<select id="yahoo-category" aria-label="カテゴリー候補" className={field} value={input.categoryId} onChange={e=>{const c=categories.find(c=>c.id===e.target.value);if(c)setInput(i=>({...i,categoryId:c.id,categoryName:c.path}));}}>
            <option value="">選択してください</option>{categories.map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select>}
          <p className="mt-2 text-sm">選択中：{input.categoryName||'未選択'}</p>
        </div>
        <div><label className="flex gap-2 text-sm"><input type="checkbox" checked={input.automaticEnd !== false} onChange={e => change("automaticEnd", e.target.checked)} />終了を自動設定（1日・21時）</label>
          {input.automaticEnd === false && <><label htmlFor="yahoo-end" className="mt-2 block text-sm">終了希望日時（日本時間）</label>
          <input id="yahoo-end" type="datetime-local" step={3600} className={field} value={input.endAtJst} onChange={e => change("endAtJst", e.target.value)} /></>}
          <p className="mt-1 text-xs text-gray-600">出品準備時に翌日の21時を設定します。確定日時は出品前の確認画面に表示します。</p></div>
        {input.format === "AUCTION" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={input.autoExtension} onChange={e => change("autoExtension", e.target.checked)} />終了直前の入札で自動延長する</label>}
        <dl className="grid grid-cols-2 gap-2 rounded bg-gray-50 p-3 text-sm">
          <dt>出品画像</dt><dd>{draft?.images.length ?? 0}枚（共通下書きの選択順）</dd>
          <dt>配送方法</dt><dd><select aria-label="ヤフオクの配送方法" className={field} value={input.shippingMethod ?? draft?.shippingMethod ?? "KAZAI"} onChange={e=>change("shippingMethod",e.target.value as "KAZAI"|"SAGAWA")}>{LISTING_SHIPPING_METHODS.map(s=><option key={s.code} value={s.code}>{s.label}</option>)}</select></dd>
          <dt>送料負担</dt><dd>送料別（落札者負担・落札後に送料を連絡）</dd>
          <dt>発送元</dt><dd>埼玉県</dd>
          <dt>発送まで</dt><dd>3〜7日</dd>
        </dl>
        <p className="text-xs text-gray-600">入札や取消料がある場合は、出品停止を実行せず理由を表示します。</p>
        <button type="button" disabled={!draft || !loaded} onClick={save} className="rounded bg-blue-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">ヤフオク下書きを保存</button>
      </fieldset>
      {issues.length > 0 && <details className="mt-3 text-xs text-gray-600"><summary>出品に向けて確認する項目（{issues.length}件）</summary><ul className="mt-2 list-disc pl-5">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul><p className="mt-2">未入力の項目があっても下書きは保存できます。</p></details>}
    </>}
  </section>;
}
