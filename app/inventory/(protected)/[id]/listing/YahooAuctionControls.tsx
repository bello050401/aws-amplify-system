"use client";
import {useEffect,useRef,useState} from 'react';
import {getYahooWorkflowAction,prepareYahooPublicationAction,publishYahooListingAction,cancelYahooListingAction,reconcileYahooListingAction} from '@/app/actions/yahooAuctionWorkflow';
import type {YahooWorkflowView,YahooWorkflowResult} from '@/lib/listing/yahooAuction/workflowTypes';
import type {YahooListingResult} from '@/lib/listing/yahooAuction/listingResult';

export const yahooWorkflowMessage=(code:string)=>({
  NOT_CONFIGURED:'出品処理の設定を確認できません。',FORBIDDEN:'編集権限を確認できません。BELLOにログインし直してください。',
  AUTH_REQUIRED:'Yahoo!のログインが切れています。認証を更新してから続けてください。',
  BUSY:'別の出品処理が実行中です。完了後にもう一度操作してください。',
  SOURCE_CHANGED:'下書きが変更されました。最新の内容を保存してから出品内容を確認してください。',
  NOT_ELIGIBLE:'在庫数または販売状況が変わりました。商品情報を確認してください。',
  INVALID_INPUT:'商品名・説明・状態・価格・数量・カテゴリー・終了日時・画像を確認してください。',
  FIXED_PRICE_ONLY:'この出品機能は定額販売に対応しています。',
  CONFIRMATION_EXPIRED:'確認から時間が経過しました。出品内容をもう一度確認してください。',
  APPROVAL_MISMATCH:'出品内容の確認をやり直してください。',
  WAIT_INTERVAL:'前の送信から30秒空けて続けます。',
  VERIFY_REQUIRED:'送信結果の確認が必要です。重複を防ぐため再送せず、「送信結果を確認」を押してください。',
  PUBLICATION_RESULT_UNKNOWN:'出品結果を確認中です。出品は押し直さず「送信結果を確認」を押してください。',
  IMAGE_RESULT_UNKNOWN:'画像送信の結果を確定できません。重複送信を防ぐため、この操作を保留しています。',
  STATE_UNAVAILABLE:'操作履歴を確認できません。「送信結果を確認」で状態を取得してください。',
  BIDS_OR_STATE_CHANGED:'入札または出品状態が変わりました。ヤフオクの商品画面を確認してください。',
  CANCELLATION_FEE_OR_FORM_CHANGED:'無料で取り消せることを確認できないため、取消を実行していません。',
  CANCELLATION_RESULT_UNKNOWN:'取消の結果確認が必要です。「送信結果を確認」を押してください。',
  PREVIEW_MISMATCH:'Yahoo!の確認画面が入力内容と一致しないため、公開していません。',
  UNEXPECTED_FORM:'Yahoo!の確認画面を照合できないため、公開していません。',
  IMAGE_UNAVAILABLE:'選択した画像を読み込めません。共通下書きの画像を確認してください。',
  REMOTE_CONTENT_CHANGED:'Yahoo!の商品内容が変わっています。商品画面を確認してください。',
}[code]??'処理を確定できません。送信結果を確認してください。');
const button='rounded border px-4 py-2 text-sm disabled:opacity-40';
export function YahooAuctionControls({inventoryId,revision,dirty,disabled,onListing}:{inventoryId:string;revision:number|null;dirty:boolean;disabled:boolean;onListing:(r:YahooListingResult|null)=>void}){
  const [view,setView]=useState<YahooWorkflowView|null>(null),[busy,setBusy]=useState(false),[running,setRunning]=useState(false);
  const [error,setError]=useState(''),[terms,setTerms]=useState(false),[stopConfirm,setStopConfirm]=useState(false),[now,setNow]=useState(Date.now());
  const flight=useRef(false),mounted=useRef(true),timer=useRef<ReturnType<typeof setTimeout>>();
  const listingCallback=useRef(onListing);listingCallback.current=onListing;
  const accept=(r:YahooWorkflowResult)=>{if(!r.ok){setError(yahooWorkflowMessage(r.code));if(r.waitUntil)setView(v=>v?{...v,waitUntil:r.waitUntil!}:v);return false;}
    setView(r.view);listingCallback.current(r.view.listing);setError(r.view.error?yahooWorkflowMessage(r.view.error):'');return true;};
  useEffect(()=>{mounted.current=true;getYahooWorkflowAction(inventoryId).then(r=>{if(mounted.current)accept(r);}).catch(()=>setError(yahooWorkflowMessage('STATE_UNAVAILABLE')));
    const tick=setInterval(()=>setNow(Date.now()),1000);
    return()=>{mounted.current=false;clearInterval(tick);clearTimeout(timer.current);};
  // Per-product load only. The callback is stored in a ref to avoid duplicate reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[inventoryId]);
  const waitSeconds=Math.max(0,Math.ceil(((view?.waitUntil??0)-now)/1000));
  const uncertain=view&&['IMAGE_PENDING','PUBLISH_PENDING','CANCEL_PENDING','VERIFY_REQUIRED'].includes(view.stage);
  async function execute(action:()=>Promise<YahooWorkflowResult>){
    if(flight.current)return;flight.current=true;setBusy(true);setError('');
    try{accept(await action());}catch{setError(yahooWorkflowMessage('STATE_UNAVAILABLE'));const r=await getYahooWorkflowAction(inventoryId).catch(()=>null);if(r)accept(r);}
    finally{flight.current=false;setBusy(false);}
  }
  async function prepare(){
    if(flight.current||!revision||dirty||disabled)return;
    flight.current=true;setBusy(true);setRunning(true);setTerms(false);setError('');
    try{
      const r=await prepareYahooPublicationAction(inventoryId,revision);
      if(!mounted.current)return;
      if(!r.ok&&r.code==='WAIT_INTERVAL'){
        setView(v=>v?{...v,waitUntil:r.waitUntil??Date.now()+30_000}:v);
        timer.current=setTimeout(()=>{flight.current=false;void prepare();},Math.max(1000,(r.waitUntil??Date.now()+30_000)-Date.now()+200));return;
      }
      accept(r);
      if(r.ok&&r.view.stage==='PREPARING'){
        timer.current=setTimeout(()=>{flight.current=false;void prepare();},Math.max(500,r.view.waitUntil-Date.now()+200));return;
      }
    }catch{setError(yahooWorkflowMessage('STATE_UNAVAILABLE'));}
    flight.current=false;setBusy(false);setRunning(false);
  }
  const listed=view?.listing?.remoteStatus==='open';
  return <div className="my-3 rounded border border-blue-200 p-3">
    <p className="text-sm">{listed?'出品中です。停止すると、再出品へ切り替わります。':view?.listing?.remoteStatus==='cancelled'?'出品停止中です。内容を確認して再出品できます。':'入力した内容を確認してから出品します。'}</p>
    <p className="mt-1 text-xs text-gray-600">送料込み・出品操作は30秒間隔。入札や取消料金がある場合は停止しません。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {listed?<button type="button" className={button+' bg-red-700 text-white'} disabled={busy||disabled||!!uncertain||waitSeconds>0} onClick={()=>setStopConfirm(true)}>出品停止</button>:
        <button type="button" className={button+' bg-blue-700 text-white'} disabled={!view||busy||disabled||dirty||!revision||!!uncertain} onClick={prepare}>{running?'出品内容を確認中…':view?.listing?'再出品の内容を確認':'出品内容を確認'}</button>}
      <button type="button" className={button} disabled={busy} onClick={()=>execute(()=>reconcileYahooListingAction(inventoryId))}>送信結果を確認</button>
    </div>
    {dirty&&<p className="mt-2 text-xs text-amber-800">変更した下書きを保存すると、出品内容を確認できます。</p>}
    {waitSeconds>0&&<p role="status" className="mt-2 text-sm">次の送信まで {waitSeconds} 秒</p>}
    {running&&<p role="status" className="mt-2 text-sm">画像 {view?.uploaded??0} / {view?.imageCount??0} 枚を処理済み。確認画面を準備しています。</p>}
    {error&&<p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {stopConfirm&&listed&&<div role="dialog" aria-label="出品停止の確認" className="mt-3 rounded border bg-red-50 p-3 text-sm">
      <p>{view.listing!.title}（{view.listing!.priceYen.toLocaleString()}円）を取り消します。入札なし・取消料なしを確認して実行します。</p>
      <button type="button" className={button+' mt-3 bg-red-700 text-white'} disabled={busy||waitSeconds>0} onClick={()=>{setStopConfirm(false);void execute(()=>cancelYahooListingAction(inventoryId,view.listing!.auctionId));}}>この出品を停止する</button>
      <button type="button" className={button+' ml-2'} disabled={busy} onClick={()=>setStopConfirm(false)}>戻る</button>
    </div>}
    {view?.confirmation&&!dirty&&<div role="dialog" aria-label="ヤフオク出品の確認" className="mt-3 rounded border bg-blue-50 p-3 text-sm">
      <h3 className="font-bold">{view.confirmation.relist?'再出品':'出品'}する内容</h3>
      <p className="mt-2">{view.confirmation.title}</p>
      <p>{view.confirmation.priceYen.toLocaleString()}円・数量 {view.confirmation.quantity}・画像 {view.uploaded} 枚</p>
      <p>{view.confirmation.category}</p><p>送料込み・{view.confirmation.shipping}</p>
      <p>終了：{view.confirmation.endAtJst.replace('T',' ')}台（日本時間）</p>
      <label className="mt-3 flex gap-2"><input type="checkbox" checked={terms} onChange={e=>setTerms(e.target.checked)}/>この内容とYahoo!オークションの利用規約・ガイドラインに同意して公開する</label>
      <button type="button" className={button+' mt-3 bg-blue-700 text-white'} disabled={!terms||busy||disabled||waitSeconds>0} onClick={()=>execute(()=>publishYahooListingAction(inventoryId,view.confirmationId!,terms))}>この内容で{view.confirmation.relist?'再出品':'出品'}する</button>
    </div>}
  </div>;
}
