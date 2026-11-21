'use client';
export type AutomationView={enabled:boolean;enabledAt?:string|null;lastRunAt:string|null;jobs:Record<string,{state:string;phase:string;reason?:string;elapsedMs?:number}>};
export function SaleAutomationSummary({value}:{value:AutomationView}){
 const time=(at:string)=>new Date(at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
 return <div className="notice" role="status"><strong>{value.enabled?'自動売却・販売先の在庫調整：有効':'自動売却：停止中'}</strong>
  <p>{value.enabled?'商品・数量・金額を確認できる注文を処理します。メルカリはパソコンで商品名と写真を照合してから進めます。':'新しい注文の自動売却は行いません。処理中の販売先確認と、手動の売却登録は引き続き利用できます。'}</p>
  {value.enabled&&value.enabledAt&&<small>対象：{time(value.enabledAt)}以後の注文</small>}
  {value.lastRunAt&&<small style={{display:'block'}}>最終確認：{time(value.lastRunAt)}</small>}
 </div>;
}
const reasons:Record<string,string>={NOT_UNIQUE:'出品IDに対応する商品を確認してください。',NO_ITEM_ID:'通知に商品IDがありません。商品を選択してください。',QUANTITY_UNKNOWN:'売却数量を確認してください。',SET_REVIEW:'セットの点数を確認してください。',ORDER_REVIEW:'注文状態・金額・送料を確認してください。',UNTRUSTED_MAIL:'メールの送信元認証が未確認です。',STOCK_CHANGED:'在庫情報が変更されています。',WAITING_PAYMENT:'入金待ち：在庫数量は変更していません。',CANCELLED:'キャンセルされた注文です。',HISTORICAL:'自動化開始前の通知です。重複を確認して売却登録してください。',EC_RESULT_UNCONFIRMED:'停止結果が未確認です。再送せず結果を照合します。',EC_REVIEW_REQUIRED:'販売先の紐付け・停止結果を確認してください。',SOLD_CHANNEL_PROTECTED:'販売先の商品ページを保護しています。',CHANNEL_UNSUPPORTED:'手動の売却登録をご利用ください。'};
Object.assign(reasons,{
 MERCARI_DESKTOP_WAITING:'パソコンで商品名・写真を確認する処理を待っています。',
 MERCARI_IDENTIFICATION_REVIEW:'メルカリの注文と在庫商品の一致を確認してください。',
 MERCARI_ORDER_CONTEXT_REQUIRED:'注文ページを確認する情報が不足しています。',
 MERCARI_ORDER_URL_INVALID:'注文ページの識別情報を確認できませんでした。',
 MERCARI_DESKTOP_REVIEW:'パソコンでの商品確認・数量変更を確認してください。',
 PRE_SALE_WAITING:'先行する在庫・販売先の確認が終わるまで待機しています。',
 STOCK_LOCKED:'同じ商品の先行処理が終わるまで待機しています。',
 ECONVENI_LINK_REQUIRED:'eコンビニとの対応を確認しています。',
 ECONVENI_BINDING_REQUIRED:'eコンビニの商品と在庫を一意に結び付けられませんでした。対応する商品を確認してください。',
 PREVIOUS_SALE_PENDING:'同じ商品の先行する売却・他サイト更新が完了するまで待機しています。',
 MERCARI_DESKTOP_IDENTIFICATION:'パソコンでメルカリの注文・写真と在庫商品を照合するのを待っています。',
 MERCARI_DESKTOP_VERIFICATION:'パソコンで商品名・写真の一致を確認するのを待っています。',
 YAHOO_SALE_AUTH_REQUIRED:'ヤフオクとの接続認証を更新する必要があります。',
 YAHOO_SALE_ACCESS_DENIED:'ヤフオクの商品確認が拒否されました。接続先アカウントを確認してください。',
 YAHOO_SALE_RATE_LIMITED:'ヤフオク側のアクセス制限により確認を保留しています。',
 YAHOO_SALE_FORM_CHANGED:'ヤフオクの商品ページから出品者・数量を確認できませんでした。接続とページの状態を確認してください。',
 YAHOO_SALE_READ_UNAVAILABLE:'ヤフオクの商品情報を取得できませんでした。',
 BASE_ORDERS_AUTH_REQUIRED:'BASEとの再接続が必要です。「連携・手数料設定」からBASE注文連携を開いてください。',
});
export function SaleAutomationStatus({job,onRetry}:{job?:AutomationView['jobs'][string];onRetry:()=>void}){
 if(!job)return null;
 const done=job.state==='SALE_AUTO_COMPLETE',attention=job.state==='SALE_AUTO_ATTENTION';
 return <div role={attention?'alert':'status'} style={{borderRadius:10,padding:'12px 14px',marginTop:12,background:done?'#edf5ef':attention?'#fff5e4':'#f1f4f3',fontSize:13,lineHeight:1.7}}>
  <strong>{done?'売却・販売先の確認完了':attention?'確認が必要です':job.reason==='WAITING_PAYMENT'?'入金待ち':job.phase==='WAITING'?'確認・再試行待ち':'自動処理中'}</strong>
  {job.reason&&<div>{reasons[job.reason]??'結果を確定できませんでした。接続・紐付けを確認してください。'}</div>}
  {attention&&<button type="button" onClick={onRetry} style={{marginTop:8}}>結果を再確認</button>}
 </div>;
}
