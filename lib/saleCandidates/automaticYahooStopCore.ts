import {createHash} from 'node:crypto';
import {yahooAuctionIdValid} from '../listing/yahooAuction/auctionId';
import type {YahooListingEvidence} from '@/lib/listing/yahooAuction/webHttpListing';

export type AutomaticYahooStopRequest={candidateId:string;inventoryId:string;inventoryVersion:string;externalId:string;reconcileOnly?:boolean};
export type AutomaticYahooStopBinding=AutomaticYahooStopRequest&{productId:string;bindingVersion:string;bindingKind:'ECONVENI_ONLY'|'LEGACY_BOUND'};
type Expected=Pick<YahooListingEvidence,'title'|'priceYen'|'quantity'>;
export type AutomaticYahooStopReceipt=AutomaticYahooStopBinding&{pk:string;revision:number;updatedAt:string;fingerprint:string;expected:Expected;state:'SEND_RESERVED'|'VERIFY_REQUIRED'|'DONE'};
export type AutomaticYahooStopResult={status:'DONE'|'REVIEW'|'WAIT'|'VERIFY_REQUIRED';message:string;nextAt?:number};
type ReadResult={ok:true;value:YahooListingEvidence}|{ok:false;code:string};
export type AutomaticYahooStopPorts={
 read:()=>Promise<AutomaticYahooStopReceipt|null>;
 check:()=>Promise<void>;
 observe:()=>Promise<ReadResult>;
 cancel:(expected:Expected,beforeSend:()=>Promise<void>)=>Promise<ReadResult>;
 commit:(old:AutomaticYahooStopReceipt|null,next:AutomaticYahooStopReceipt,reserve:boolean)=>Promise<AutomaticYahooStopReceipt>;
};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const automaticYahooStopKey=(r:AutomaticYahooStopRequest)=>`ECONVENI#AUTO_YAHOO_STOP#${r.inventoryId}#${r.candidateId}`;
const identity=(r:AutomaticYahooStopBinding)=>[r.candidateId,r.inventoryId,r.inventoryVersion,r.externalId,r.productId,r.bindingVersion,r.bindingKind];
const fingerprint=(r:AutomaticYahooStopBinding,expected:Expected)=>digest([identity(r),expected]);
const hold:AutomaticYahooStopResult={status:'REVIEW',message:'ヤフオクの認証・所有者・手数料なし取消の条件を確認できないため、自動停止を保留しています。売却登録は保存済みです。'};
const unknown:AutomaticYahooStopResult={status:'VERIFY_REQUIRED',message:'ヤフオクの取消結果が未確認です。再送せず、同じ出品の停止結果を確認します。売却登録は保存済みです。'};
const fresh=(r:YahooListingEvidence,id:string,now:number)=>r.owned===true&&r.auctionId===id&&typeof r.title==='string'&&r.title.length>0&&[...r.title].length<=65&&Number.isSafeInteger(r.priceYen)&&r.priceYen>0&&Number.isSafeInteger(r.quantity)&&r.quantity>0&&r.quantity<=9&&Number.isFinite(Date.parse(r.checkedAt))&&now-Date.parse(r.checkedAt)>=-60000&&now-Date.parse(r.checkedAt)<=300000;
const noBids=(r:YahooListingEvidence)=>r.bids===0&&r.bidders===0&&r.highestBidders===0;
const matches=(r:YahooListingEvidence,e:Expected)=>r.title===e.title&&r.priceYen===e.priceYen&&r.quantity===e.quantity;
const stopped=(r:YahooListingEvidence)=>['cancelled','closed'].includes(r.status)&&noBids(r);
/** One immutable receipt per sale/target. A reserved attempt can only be read back, even after a lost reservation acknowledgement. */
export async function runAutomaticYahooStop(binding:AutomaticYahooStopBinding,ports:AutomaticYahooStopPorts,now=Date.now()):Promise<AutomaticYahooStopResult>{
 if(!/^[a-f0-9]{64}$/.test(binding.candidateId)||!binding.inventoryId||!binding.inventoryVersion||!yahooAuctionIdValid(binding.externalId)||!binding.productId||!binding.bindingVersion)return hold;
 let receipt:AutomaticYahooStopReceipt|null=null,reservationAttempted=false,waitUntil:number|undefined;
 try{
  receipt=await ports.read();
  if(receipt&&(receipt.pk!==automaticYahooStopKey(binding)||digest(identity(receipt))!==digest(identity(binding))||receipt.fingerprint!==fingerprint(binding,receipt.expected)))return {...unknown,message:'前回の取消依頼と紐付け・在庫の版が変わっています。再送せず確認してください。'};
  await ports.check();
  const before=await ports.observe();if(!before.ok||!fresh(before.value,binding.externalId,now))return receipt?unknown:hold;
  if(receipt){
   if(!matches(before.value,receipt.expected)||!stopped(before.value))return unknown;
   if(receipt.state!=='DONE')receipt=await ports.commit(receipt,{...receipt,state:'DONE'},false);
   return {status:'DONE',message:'ヤフオクの同じ出品が停止済みであることを確認しました。'};
  }
  const expected:Expected={title:before.value.title,priceYen:before.value.priceYen,quantity:before.value.quantity};
  const next:AutomaticYahooStopReceipt={...binding,pk:automaticYahooStopKey(binding),revision:0,updatedAt:'',fingerprint:fingerprint(binding,expected),expected,state:'SEND_RESERVED'};
  if(stopped(before.value)){receipt=await ports.commit(null,{...next,state:'DONE'},false);return {status:'DONE',message:'ヤフオクの停止済み出品を確認しました。取消は送信していません。'};}
  if(binding.reconcileOnly)return unknown;
  if(before.value.status!=='open'||!noBids(before.value))return hold;
  const result=await ports.cancel(expected,async()=>{
   await ports.check();reservationAttempted=true;
   try{receipt=await ports.commit(null,next,true);}catch(error){const e=error as {code?:string;readyAt?:number};if(e.code==='WAIT_INTERVAL'&&Number.isFinite(e.readyAt))waitUntil=e.readyAt;throw error;}
  });
  receipt=(()=>receipt as AutomaticYahooStopReceipt|null)();
  if(!receipt)return waitUntil?{status:'WAIT',nextAt:waitUntil,message:'他のEC操作との間隔を保ってから取消条件を確認します。'}:reservationAttempted?unknown:hold;
  if(result.ok&&fresh(result.value,binding.externalId,Date.now())&&matches(result.value,expected)&&result.value.status==='cancelled'&&noBids(result.value)){
   receipt=await ports.commit(receipt,{...receipt,state:'DONE'},false);
   return {status:'DONE',message:'手数料なしでヤフオクの取消・停止を確認しました。'};
  }
  receipt=await ports.commit(receipt,{...receipt,state:'VERIFY_REQUIRED'},false);return unknown;
 }catch{return !receipt&&waitUntil?{status:'WAIT',nextAt:waitUntil,message:'他のEC操作との間隔を保ってから取消条件を確認します。'}:receipt||reservationAttempted?unknown:hold;}
}
