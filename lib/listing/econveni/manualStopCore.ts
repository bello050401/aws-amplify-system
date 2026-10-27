import {createHash,randomUUID} from 'node:crypto';
import type {EcChannel,EcReview} from '../ecManagement';

export type StopBinding={inventoryId:string;productId:string;linkRevision:number;inventoryVersion:string;title:string;listingId:string};
export type StopReceipt=StopBinding & {pk:string;channel:EcChannel;revision:number;updatedAt:string;state:'READY'|'PENDING'|'DONE';token:string;actor:string;expiresAt:number;fingerprint:string;acknowledged?:boolean};
export type StopObservation={listingId:string|null;active:boolean;stopped:boolean;fingerprint:string;title:string};
export type ManualStopPorts={
 read:()=>Promise<StopReceipt|null>;
 observe:(receipt:StopReceipt|null)=>Promise<StopObservation>;
 preview:()=>Promise<void>;
 send:()=>Promise<boolean>;
 commit:(old:StopReceipt|null,next:StopReceipt,reserve:boolean)=>Promise<StopReceipt>;
};
export const stopReceiptKey=(id:string,channel:EcChannel)=>`ECONVENI#MANUAL_STOP#${id}#${channel}`;
export const stopFingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A later status check never repeats an uncertain external write. Only an explicit fresh approval can send. */
export async function runManualStop(binding:StopBinding,channel:EcChannel,actor:string,ports:ManualStopPorts,token?:string):Promise<EcReview>{
 const base:EcReview={inventoryId:binding.inventoryId,channel,operation:'STOP',title:binding.title,status:'BLOCKED',message:'停止対象が変わりました。対象商品を確認し直してください。'};
 let receipt=await ports.read();
 const same=receipt&&receipt.productId===binding.productId&&receipt.linkRevision===binding.linkRevision&&receipt.listingId===binding.listingId;
 if(receipt&&receipt.state!=='READY'&&!same)return base;
 if(token&&(!same||receipt?.token!==token||receipt.actor!==actor))return base;
 const observed=await ports.observe(receipt);
 if(observed.listingId&&observed.listingId!==binding.listingId)return base;
 const complete=async()=>{
  const next:StopReceipt={pk:stopReceiptKey(binding.inventoryId,channel),channel,revision:0,updatedAt:'',token:randomUUID(),actor,expiresAt:0,fingerprint:observed.fingerprint,...receipt,...binding,state:'DONE'};
  receipt=await ports.commit(receipt,next,false);
  return {...base,status:'DONE' as const,message:'出品停止を確認しました。'};
 };
 if(observed.stopped)return complete();
 if(receipt?.state==='PENDING'||receipt?.state==='DONE')return {...base,message:'前回の停止結果を確認できません。再送せず、販売先で状態を確認してください。'};
 if(!observed.active||observed.listingId!==binding.listingId)return base;
 if(!token){
  await ports.preview();
  const next:StopReceipt={...binding,pk:stopReceiptKey(binding.inventoryId,channel),channel,revision:0,updatedAt:'',state:'READY',token:randomUUID(),actor,expiresAt:Date.now()+600000,fingerprint:observed.fingerprint};
  receipt=await ports.commit(receipt,next,false);
  return {...base,status:'READY',token:receipt.token,message:channel==='MERCARI_SHOPS'?'メルカリShopsの商品を削除して出品を停止します。':'この販売先の出品を停止します。',details:[`eコンビニ商品番号：${binding.productId}`,`出品ID：${binding.listingId}`,`販売先の商品名：${observed.title}`,'選択した販売先だけを停止します。BELLOの在庫・他の販売先は変更しません。']};
 }
 if(!receipt||receipt.state!=='READY'||receipt.expiresAt<Date.now()||receipt.inventoryVersion!==binding.inventoryVersion||receipt.fingerprint!==observed.fingerprint)return base;
 await ports.preview();
 // Persist and reserve the account-wide 30-second send slot before crossing the external boundary.
 receipt=await ports.commit(receipt,{...receipt,state:'PENDING'},true);
 const acknowledged=await ports.send();
 if(acknowledged)receipt=await ports.commit(receipt,{...receipt,acknowledged:true},false);
 const after=await ports.observe(receipt);
 if(after.stopped&&(!after.listingId||after.listingId===binding.listingId))return complete();
 return {...base,message:'停止結果の確認が必要です。「結果を再確認」で状態を取得してください。重複送信はしません。'};
}
