'use client';
import React,{useEffect,useRef,useState} from 'react';
import {SOLD_OUT_MARKETS,japanToday,validateSoldOut,type SoldOutRequest,type SoldOutResult} from '../../lib/inventory/soldOutInput';
import {allocateFee,calculateFee,type SaleCandidate,type FeeConfig} from '../../lib/saleCandidates/model';
import {saleAmounts,saleTitle,type SalePricing} from '../../lib/inventory/salePricing';
export type SaleProduct={id:string;name:string;quantity:number;updatedAt:string;market?:string|null;salePrice?:number|null;externalProductId?:string|null};
type Outcome={ok:true;result:SoldOutResult}|{ok:false;code?:string;error:string};
export function SaleRegistrationForm({item,candidate,fees,save,onComplete,onCancel,onLocked}:{item:SaleProduct;candidate?:SaleCandidate;fees?:FeeConfig;save:(r:SoldOutRequest)=>Promise<Outcome>;onComplete:(r:SoldOutResult)=>void;onCancel:()=>void;onLocked?:(value:boolean)=>void}){
 const [quantity,setQuantity]=useState(candidate?(candidate.quantity===null?'':String(candidate.quantity)):'1');
 const [name,setName]=useState(candidate?.name||item.name),[date,setDate]=useState(candidate?.saleDate||japanToday()),[externalId,setExternalId]=useState(candidate?.orderId??item.externalProductId??'');
 const [market,setMarket]=useState(candidate?({BASE:'ベイス',MERCARI:'メルカリSHOP',YAHOO:'ヤフオク',DIRECT:'直接取引'}[candidate.channel]):item.market||'');
 const [price,setPrice]=useState(candidate?(candidate.unitPrice===null?'':String(candidate.unitPrice)):item.salePrice==null?'':String(item.salePrice));
 const [setMode,setSetMode]=useState(false),[perSet,setPerSet]=useState('2'),[checked,setChecked]=useState(false);
 const total=Number(price)*Number(quantity),physicalQuantity=Number(quantity)*(setMode?Number(perSet):1);
 const [commission,setCommission]=useState(''),[feeManual,setFeeManual]=useState(false),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[route,setRoute]=useState(candidate?.orderRoute??'UNKNOWN');
 const inflight=useRef(false),pending=useRef<SoldOutRequest|null>(null);
 const channel=market==='ベイス'?'BASE':market==='メルカリSHOP'?'MERCARI':market==='ヤフオク'?'YAHOO':'DIRECT';
 // Multi-line BASE fees must be allocated once for the order, never once per line.
 const feeAvailable=!(channel==='BASE'&&candidate&&candidate.orderLineCount>1&&!candidate?.feeAllocation);
 const orderFee=Number.isSafeInteger(total)&&total>=0&&feeAvailable&&(channel!=='BASE'||route!=='UNKNOWN')?calculateFee(channel,channel==='BASE'?(candidate?.orderTotal??total):Number(price),candidate?.payment||'',fees,route==='PAY_ID_APP'):null;
 const lineFee=candidate?.confirmedLineFee??(orderFee!==null&&candidate?.feeAllocation?allocateFee(orderFee,candidate?.feeAllocation.amounts)[candidate?.feeAllocation.index]:orderFee);
 const feeUnits=candidate?.quantity&&candidate.quantity>0?candidate.quantity:Number(quantity);
 const autoFee=channel==='BASE'?(lineFee!==null&&feeUnits>0?lineFee/feeUnits:null):orderFee;
 const fee=feeManual?commission:autoFee===null?'':String(autoFee);
 const maxUnits=Math.max(1,Math.floor(item.quantity/(setMode?Number(perSet)||1:1)));
 const locked=busy||uncertain;
 useEffect(()=>{onLocked?.(locked);},[locked,onLocked]);
 const pricing:SalePricing={mode:setMode?'SET':'UNIT',units:Number(quantity),itemsPerUnit:setMode?Number(perSet):1,unitPrice:price.trim()?Number(price):null,unitCommission:fee.trim()?Number(fee):null};
 const request=():SoldOutRequest=>({...saleAmounts(pricing),pricing,mutationId:pending.current?.mutationId||crypto.randomUUID(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,name,saleEndDate:date,externalProductId:externalId,market,...(candidate?{sourceCandidateId:candidate.id}:{})});
 const confirm=()=>{try{const r=request();validateSoldOut(r,item.quantity,item.market??'');if(candidate&&(r.salePrice===null||!fee.trim()))throw Error('価格と販売手数料を確認してください。');setError('');setChecked(false);setReview(true);}catch(e){setError((e as Error).message);}};
 const submit=async()=>{if(inflight.current||!checked&&!uncertain)return;const r=pending.current||request();pending.current=r;inflight.current=true;setBusy(true);setError('');
  try{const result=await save(r);if(result.ok){onComplete(result.result);return;}setError(result.error);setUncertain(result.code==='UNCONFIRMED');if(result.code!=='UNCONFIRMED'){pending.current=null;setReview(false);}}
  catch{setError('登録結果を確認できません。同じ内容で結果を再確認してください。');setUncertain(true);}
  finally{inflight.current=false;setBusy(false);}
 };
 return <section className="sale-form"><style>{`.sale-form{font:16px/1.5 system-ui,sans-serif;color:#1f2937}.sale-form *{box-sizing:border-box}.sale-form label{display:block;margin:12px 0}.sale-form input,.sale-form select,.sale-form textarea{display:block;width:100%;min-height:46px;padding:10px;border:1px solid #bac4d0;border-radius:8px;font:16px system-ui;background:white;color:#111}.sale-form button{border:1px solid #b8c5d4;border-radius:9px;background:white;padding:11px 18px;min-height:46px;font:inherit;color:#245bc5;cursor:pointer}.sale-form button:disabled{opacity:.5}.sale-form .primary{background:#2563eb;color:white;border-color:#2563eb}.sale-form .quantity{display:flex;gap:8px;max-width:300px}.sale-form .quantity input{min-width:0;text-align:center}.sale-form .actions{display:flex;gap:10px;position:sticky;bottom:0;background:white;padding:14px 0}.sale-form .actions .primary{flex:1}.sale-form .error{background:#fff1f1;color:#a61a1a;padding:12px}.sale-form .summary{background:#f0f5fc;border-radius:10px;padding:14px}.sale-form .hint{font-size:13px;color:#586779}`}</style>
 <div className="summary"><strong>{item.name}</strong><p className="hint">在庫ID：{item.id}</p><p>在庫 {item.quantity}点 → 売却 {physicalQuantity||'—'}点 / 残り {item.quantity-physicalQuantity}点</p>{setMode&&<p>{perSet}点 × {quantity}セット</p>}</div>
 {review?<div><h2>売却の内容確認</h2><p>{saleTitle(name,pricing)}</p><p>販売終了日：{date}</p><p>ID：{externalId||'未設定'}</p><p>市場：{market||'未設定'}</p><p>販売価格（売却分合計）：{price?total.toLocaleString()+'円':'未設定'}</p><p>販売手数料（売却分合計）：{fee?Math.round(Number(fee)*Number(quantity)).toLocaleString():'未設定'}円</p><p>売却分の「販売中」を外して「売り切れ」に変更します。</p><label><input style={{display:'inline-block',width:22,minHeight:22,marginRight:8}} type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>選んだ商品・在庫ID・売却点数に間違いありません</label></div>:<fieldset disabled={locked} style={{border:0,padding:0}}>
 <label><input type="checkbox" style={{display:'inline-block',width:22,minHeight:22,marginRight:8}} aria-label="セット売りモード" checked={setMode} onChange={e=>setSetMode(e.target.checked)}/>セット売りモード</label>{setMode&&<label>1セットの点数<input aria-label="1セットの点数" type="number" inputMode="numeric" min="2" max={item.quantity} value={perSet} onChange={e=>setPerSet(e.target.value)}/></label>}<label>{setMode?'販売セット数':'売却数量'}<div className="quantity"><button type="button" aria-label="売却数量を1減らす" onClick={()=>setQuantity(String(Math.max(1,Number(quantity)-1)))}>−</button><input aria-label="売却数量" type="number" inputMode="numeric" min="1" max={maxUnits} value={quantity} onChange={e=>setQuantity(e.target.value)}/><button type="button" aria-label="売却数量を1増やす" onClick={()=>setQuantity(String(Math.min(maxUnits,Number(quantity)+1)))}>＋</button></div></label>
 <label>商品名<textarea aria-label="商品名" value={name} maxLength={2000} rows={2} onChange={e=>setName(e.target.value)}/></label>
 <label>販売終了日<input aria-label="販売終了日" type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
 <label>{candidate?.identifierType==='AUCTION'?'オークションID':'注文ID / ID'}<input aria-label="ID" value={externalId} maxLength={256} onChange={e=>setExternalId(e.target.value)}/></label>
 <label>市場<select aria-label="市場" disabled={!!candidate&&candidate.channel!=='DIRECT'} value={market} onChange={e=>setMarket(e.target.value)}>{[...new Set(['',...SOLD_OUT_MARKETS,...(item.market?[item.market]:[])])].map(m=><option key={m} value={m}>{m||'未設定'}</option>)}</select></label>
 <label>{setMode?'販売単価（1セット・税込）':'販売単価（1点・税込）'}<input aria-label="販売価格" type="number" inputMode="numeric" min="0" step="1" value={price} onChange={e=>setPrice(e.target.value)}/></label>
 {<><p>商品代金（単価×数量）：{price&&quantity?total.toLocaleString()+'円':'—'}</p><p className="hint">注文合計：{candidate?.orderTotal?.toLocaleString()??'不明'}円 / 送料：{candidate?.shipping?.toLocaleString()??'不明'}円<br/>送料は商品の販売価格に含めません。手数料は設定から計算し、注文の割引や決済方法に合わせて変更できます。</p>{channel==="BASE"&&<label>注文経路<select aria-label="注文経路" value={route} onChange={e=>setRoute(e.target.value as typeof route)} disabled={!!candidate?.orderRoute&&candidate.orderRoute!=='UNKNOWN'}><option value="UNKNOWN">未判別・確認してください</option><option value="WEB">Webショップ</option><option value="PAY_ID_APP">PAY IDアプリ</option></select></label>}<label>{setMode?'販売手数料（1セット）':'販売手数料（1点）'}<input aria-label="販売手数料" type="number" inputMode="decimal" step="any" min="0" value={fee} onChange={e=>{setFeeManual(true);setCommission(e.target.value);}}/></label>{candidate?.feeAllocation&&<p className="hint">注文全体の手数料を商品代金の比率で配分しています。合計は注文1件分の手数料と一致します。</p>}{!feeAvailable&&<p className="hint">この注文は複数商品を含みます。注文全体の手数料を配分し、この商品の手数料を入力してください。</p>}{candidate?.warnings.map((w,i)=><p className="hint" key={i}>{w}</p>)}</>}
 </fieldset>}
 {error&&<p role="alert" className="error">{error}</p>}<div className="actions"><button onClick={review&&!uncertain?()=>setReview(false):onCancel} disabled={locked}>{review&&!uncertain?'戻る':'キャンセル'}</button><button className="primary" disabled={busy||review&&!checked&&!uncertain} onClick={review||uncertain?submit:confirm}>{busy?'登録を確認中…':uncertain?'登録結果を再確認':review?'売却を確定':'内容確認'}</button></div>
 </section>;
}
