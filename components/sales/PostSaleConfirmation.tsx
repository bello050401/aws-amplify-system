'use client';
import {useState} from 'react';
import type {PostSalePlan} from '../../lib/saleCandidates/postSaleTypes';
import {EC_CHANNEL_LABEL,type EcChannel} from '../../lib/listing/ecManagement';
export function PostSaleConfirmation({plan,onConfirm,onReview,onClose}:{plan:PostSalePlan;onConfirm:()=>Promise<void>;onReview:(packs:Partial<Record<EcChannel,number>>)=>Promise<void>;onClose:()=>void}){
 const [busy,setBusy]=useState(false),[checked,setChecked]=useState(false),[error,setError]=useState('');
 const [packs,setPacks]=useState<Partial<Record<EcChannel,number>>>(Object.fromEntries(plan.rows.filter(r=>r.operation==='STOCK').map(r=>[r.channel,r.unitsPerListing??1]))),[dirty,setDirty]=useState(false);
 return <div className="card"><h2>売却登録後のEC確認</h2><p>残り在庫：{plan.remaining}点</p>{plan.soldChannel&&<p className="notice">売れた{EC_CHANNEL_LABEL[plan.soldChannel]}の商品ページは変更・削除しません。</p>}
 {!plan.rows.length?<p>変更対象の出品はありません。</p>:plan.rows.map(r=><div className="card" key={r.channel}><strong>{EC_CHANNEL_LABEL[r.channel]}</strong><p className="meta">出品ID：{r.externalId}</p><p>{r.operation==='STOP'?'出品を停止':`数量 ${r.beforeQuantity??'現在値'} → ${r.targetQuantity}`}</p><p role={r.state==='BLOCKED'||r.state==='VERIFY_REQUIRED'?'alert':undefined}>{r.message}</p><p>{r.state==='DONE'?'確認済み':r.state==='READY'?'確認後に実行':'要確認'}</p></div>)}
 {plan.state==='REVIEW'&&plan.rows.filter(r=>r.operation==='STOCK'&&r.channel==='BASE').map(r=><label key={r.channel}>BASEの出品1個に含まれる点数<input aria-label="BASEの出品1個に含まれる点数" type="number" min="1" max="10000" value={packs[r.channel]??1} onChange={e=>{setPacks({...packs,[r.channel]:Number(e.target.value)});setDirty(true);setChecked(false);}}/></label>)}
 {error&&<p className="error" role="alert">{error}</p>}
 {dirty&&<button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onReview(packs);setDirty(false);}catch(e){setError(e instanceof Error?e.message:'数量を確認できませんでした。再度確認してください。');}finally{setBusy(false);}}}>変更する数量を再確認</button>}
 {plan.state==='REVIEW'&&plan.rows.some(r=>r.state==='READY')&&<label style={{display:'flex',gap:10,alignItems:'center'}}><input style={{width:22,minHeight:22}} type="checkbox" disabled={dirty} checked={checked} onChange={e=>setChecked(e.target.checked)}/>対象の販売先と変更内容を確認しました</label>}
 <div className="tools"><button disabled={busy} onClick={onClose}>{plan.state==='REVIEW'?'今は変更しない':'閉じる'}</button>{plan.state==='REVIEW'&&plan.rows.some(r=>r.state==='READY')&&<button className="primary" disabled={!checked||dirty||busy} onClick={async()=>{if(busy)return;setBusy(true);try{await onConfirm();}finally{setBusy(false);}}}>{busy?'結果を確認中…':'確認した販売先を変更'}</button>}</div></div>;
}
