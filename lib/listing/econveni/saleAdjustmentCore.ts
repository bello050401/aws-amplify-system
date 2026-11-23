import {createHash} from 'node:crypto';

export type SaleAdjustment = {
 candidateId:string;inventoryId:string;inventoryVersion:string;productId:string;bindingVersion:string;
 channel:'BASE'|'YAHOO';listingId:string;price:number;quantity:number;beforeQuantity:number;title:string;beforeTitle:string;
 fields:Record<string,string>;beforeFields:Record<string,string>;fingerprint:string;physicalRemaining?:number;
};
/** One offered Yahoo unit; a unit may be a pack of physical inventory. */
export function saleAdjustmentQuantity(channel:'BASE'|'YAHOO',remaining:number,pack:number){
 if(!Number.isSafeInteger(remaining)||remaining<0||!Number.isSafeInteger(pack)||pack<1)throw Error('残り在庫と1出品分の数量を確認してください。');
 const available=Math.floor(remaining/pack);
 if(channel==='YAHOO'&&available<1)throw Error('残り在庫が1出品分に足りません。');
 return channel==='YAHOO'?1:available;
}
/** New receipts separate physical stock from Yahoo's offered quantity. Legacy receipts retain their original field meaning. */
export function physicalRemainingForAdjustment(request:Pick<SaleAdjustment,'physicalRemaining'|'fields'>):number{
 const explicit=Object.hasOwn(request,'physicalRemaining');
 const value=explicit?request.physicalRemaining:/^\d+$/.test(request.fields.products_quantity??'')?Number(request.fields.products_quantity):undefined;
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('残り在庫の記録を確認してください。');
 return value;
}
/** A public read only vetoes an active predecessor; it does not grant write authority. */
export function closedYahooPredecessor(e:{auctionId:string;status:string},id:string){return e.auctionId===id&&e.status==='closed';}
export type AdjustmentStep='CLEAR'|'EDIT'|'STOCK'|'PUBLISH';
export type AdjustmentReceipt={pk:string;inventoryId:string;revision:number;updatedAt:string;request:SaleAdjustment;
 done:AdjustmentStep[];pending?:AdjustmentStep;newListingId?:string;newListingUrl?:string;complete?:boolean};
export type AdjustmentResult={status:'DONE'|'WAIT'|'BLOCKED';message:string;nextAt?:number;newListingId?:string};
export const adjustmentFingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const adjustmentKey=(r:Pick<SaleAdjustment,'inventoryId'|'candidateId'|'channel'>)=>`ECONVENI#SALE_ADJUST#${r.inventoryId}#${r.candidateId}#${r.channel}`;
export type AdjustmentPorts={
 read:()=>Promise<AdjustmentReceipt|null>;
 checkBinding:(request:SaleAdjustment)=>Promise<void>;
 observe:(request:SaleAdjustment,step:AdjustmentStep)=>Promise<{done:boolean;safe:boolean;newListingId?:string;newListingUrl?:string}>;
 commit:(previous:AdjustmentReceipt|null,next:AdjustmentReceipt,reserve:boolean)=>Promise<AdjustmentReceipt>;
 send:(request:SaleAdjustment,step:AdjustmentStep)=>Promise<void>;
 finish:(receipt:AdjustmentReceipt)=>Promise<void>;
};
/** One reserved external write per call. A lost response is reconciled, never blindly retried. */
export async function runSaleAdjustment(request:SaleAdjustment,ports:AdjustmentPorts):Promise<AdjustmentResult>{
 let receipt=await ports.read();
 if(receipt&&receipt.request.fingerprint!==request.fingerprint)throw Error('確認内容が変わりました。');
 if(receipt?.complete)return {status:'DONE',message:'変更済みの結果を確認しました。',newListingId:receipt.newListingId};
 if(Object.hasOwn(request,'physicalRemaining'))physicalRemainingForAdjustment(request);
 if(request.channel==='YAHOO'&&(request.quantity!==1||request.fields.products_quantity!=='1'))return {status:'BLOCKED',message:'ヤフオクは1点ずつ出品します。古い準備情報を送信せず確認し直してください。'};
 await ports.checkBinding(request);
 const steps:AdjustmentStep[]=request.channel==='YAHOO'?['CLEAR','EDIT','PUBLISH']:['EDIT','STOCK'];
 for(const step of steps){
  if(receipt?.done.includes(step))continue;
  const observation=await ports.observe(request,step);
  if(step==='PUBLISH'&&observation.done&&receipt?.pending!=='PUBLISH')return {status:'BLOCKED',message:'別の操作で新しい出品が作成されています。商品と出品IDを確認してください。'};
  if(observation.done){
   receipt=await ports.commit(receipt,{...(receipt??{pk:adjustmentKey(request),inventoryId:request.inventoryId,revision:0,updatedAt:'',request,done:[]}),done:[...(receipt?.done??[]),step],pending:undefined,...(observation.newListingId?{newListingId:observation.newListingId,newListingUrl:observation.newListingUrl}:{})},false);
   continue;
  }
  if(receipt?.pending||!observation.safe)return {status:'BLOCKED',message:'前回の処理結果または出品情報が変わっています。重複送信を止めています。eコンビニで確認してください。'};
  receipt=await ports.commit(receipt,{...(receipt??{pk:adjustmentKey(request),inventoryId:request.inventoryId,revision:0,updatedAt:'',request,done:[]}),pending:step},true);
  // PENDING is durable BEFORE the external request, including for timeouts/crashes.
  try{await ports.send(request,step);}catch{/* Reconcile the read-back even when the response was lost. */}
  const after=await ports.observe(request,step);
  if(!after.done)return {status:'BLOCKED',message:'変更結果が未確認です。再送せず、eコンビニで確認してください。'};
  receipt=await ports.commit(receipt,{...receipt,done:[...receipt.done,step],pending:undefined,...(after.newListingId?{newListingId:after.newListingId,newListingUrl:after.newListingUrl}:{})},false);
  if(step!==steps.at(-1))return {status:'WAIT',message:step==='CLEAR'?'売却済みページを残して出品IDを解除しました。残り在庫の準備へ進みます。':'残り在庫の出品情報を保存しました。次の処理を待っています。',nextAt:Date.now()+30000};
 }
 if(!receipt)throw Error('処理記録を確認できません。');
 // finish atomically commits completion and replacement listing bindings.
 await ports.finish(receipt);
 return {status:'DONE',message:request.channel==='YAHOO'?'売却済みページを残し、新しい出品を確認しました。':'BASEの数量とeコンビニの保存内容を確認しました。',newListingId:receipt.newListingId};
}
