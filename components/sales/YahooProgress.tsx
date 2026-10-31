import React from 'react';
import {YAHOO_STATUS_LABELS,type SaleCandidate,type YahooSaleStatus} from '../../lib/saleCandidates/model';
const stages:YahooSaleStatus[]=['WON','ADDRESS_CONFIRMED','AWAITING_SHIPMENT'];
export function YahooProgress({candidate}:{candidate:SaleCandidate}){
 if(candidate.channel!=='YAHOO'||!candidate.yahooStatus)return null;
 return <div className="yahoo-progress" aria-label="ヤフオクの取引状況">
  <strong>取引状況：{YAHOO_STATUS_LABELS[candidate.yahooStatus]}</strong>
  {candidate.yahooPaymentState==='WAITING'&&<p style={{color:'#8b5700',fontSize:13}}>入金待ち · {candidate.yahooPaymentNotice?'商品情報を自動更新中':'支払い完了メールを待っています'}<br/>他ECの出品停止は進められます。</p>}
  {candidate.yahooPaymentState==='APPLIED'&&<p style={{color:'#196759',fontSize:13}}>入金確認済み · 販売終了日を登録しました</p>}
  {candidate.yahooPaymentError&&<p role="alert" style={{color:'#b42318',fontSize:13}}>{candidate.yahooPaymentError}</p>}
  <ol style={{display:'flex',flexWrap:'wrap',gap:'8px 14px',listStyle:'none',padding:0,margin:'8px 0'}}>{stages.map(stage=>{
   const at=candidate.yahooEvents?.[stage];
   return <li key={stage} aria-current={stage===candidate.yahooStatus?'step':undefined} style={{color:at?'#245bc5':'#64748b',fontSize:13}}>
    {at?'✓':'○'} {YAHOO_STATUS_LABELS[stage]}{at&&<time dateTime={at} style={{display:'block',fontSize:11}}>{new Date(at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>}
   </li>;
  })}</ol>
 </div>;
}
