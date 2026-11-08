'use client';
export type AutomationView={enabled:boolean;lastRunAt:string|null;jobs:Record<string,{state:string;phase:string;reason?:string;elapsedMs?:number}>};
const reasons:Record<string,string>={NOT_UNIQUE:'出品IDに対応する商品を確認してください。',NO_ITEM_ID:'通知に商品IDがありません。商品を選択してください。',QUANTITY_UNKNOWN:'売却数量を確認してください。',SET_REVIEW:'セットの点数を確認してください。',ORDER_REVIEW:'注文状態・金額・送料を確認してください。',UNTRUSTED_MAIL:'メールの送信元認証が未確認です。',STOCK_CHANGED:'在庫情報が変更されています。',WAITING_PAYMENT:'入金待ち：在庫数量は変更していません。',CANCELLED:'キャンセルされた注文です。',HISTORICAL:'自動化開始前の通知です。重複を確認して売却登録してください。',EC_RESULT_UNCONFIRMED:'停止結果が未確認です。再送せず結果を照合します。',EC_REVIEW_REQUIRED:'販売先の紐付け・停止結果を確認してください。',SOLD_CHANNEL_PROTECTED:'販売先の商品ページを保護しています。',CHANNEL_UNSUPPORTED:'手動の売却登録をご利用ください。'};
export function SaleAutomationStatus({job,onRetry}:{job?:AutomationView['jobs'][string];onRetry:()=>void}){
 if(!job)return null;
 const done=job.state==='SALE_AUTO_COMPLETE',attention=job.state==='SALE_AUTO_ATTENTION';
 return <div role={attention?'alert':'status'} style={{borderRadius:10,padding:'12px 14px',marginTop:12,background:done?'#edf5ef':attention?'#fff5e4':'#f1f4f3',fontSize:13,lineHeight:1.7}}>
  <strong>{done?'売却・販売先の確認完了':attention?'確認が必要です':job.phase==='WAITING'?'入金待ち':'自動処理中'}</strong>
  {job.reason&&<div>{reasons[job.reason]??'結果を確定できませんでした。接続・紐付けを確認してください。'}</div>}
  {attention&&<button type="button" onClick={onRetry} style={{marginTop:8}}>結果を再確認</button>}
 </div>;
}
