import 'server-only';
import {randomUUID} from 'node:crypto';
import {EconveniHttpSession} from './httpSession';
import {econveniCredentialStore} from './credentials';
import {econveniStore} from './runtimeStore';
import {withEconveniAccount} from './accountWorkflow';
import {runEconveniCommand} from './commandWorkflow';
import {econveniFailure} from './failure';
import type {EcReview} from '../ecManagement';

/** Native workflow adapter for the shared, durable STOP command. Cannot publish or create products. */
export async function nativeStop(id:string,channel:'YAHOO'|'MERCARI_SHOPS',actor:string,token?:string):Promise<EcReview>{
 const base:EcReview={inventoryId:id,channel,operation:'STOP',title:'',status:'BLOCKED',message:'停止する出品を確認できません。'};
 const store=econveniStore(id),session=new EconveniHttpSession();
 try{return await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),async()=>{
  const current=await store.read();if(!current||current.save.state!=='SUCCEEDED'||!current.save.productId||!current.save.fingerprint)return base;
  const own=current.channels[channel];
  if(['PENDING','VERIFY_REQUIRED'].includes(own.state)){
   if(own.operation!=='STOP')return base;
   const checked=await runEconveniCommand(store,session,{inventoryId:id,channel,operation:'STOP',fingerprint:current.save.fingerprint,title:'',price:0,allowMercariRemoval:true});
   return {...base,status:checked.channels[channel].state==='SUCCEEDED'?'DONE':'BLOCKED',message:checked.channels[channel].state==='SUCCEEDED'?'停止結果を確認しました。':'前回の停止結果が未確認です。再送していません。'};
  }
  const remote=await session.readInventory(id);if(!remote||remote.productId!==current.save.productId)return base;
  const state=remote.channels[channel];
  if(state.state==='INACTIVE'&&own.remoteStatus==='INACTIVE'&&(!state.listingId||state.listingId===own.listingId))return {...base,status:'DONE',message:'eコンビニで停止状態を確認しました。'};
  if(state.state!=='ACTIVE'||!state.listingId||state.listingId!==own.listingId)return base;
  if(!token){
   const {values}=await session.saleProductFields(current.save.productId),title=values[channel==='YAHOO'?'products_name':'mercariShops_name'],raw=values[channel==='YAHOO'?'products_price':'mercariShops_price'];
   if(!title||!/^\d+$/.test(raw??''))return base;
   const price=Number(raw);await session.publicationPreview({channel,operation:'STOP',productId:current.save.productId,title,price});
   const approval={token:randomUUID(),actor,operation:'STOP' as const,fingerprint:current.save.fingerprint,expiresAt:Date.now()+600000,title,price};
   await store.commit(current,{...current,approvals:{...current.approvals,[channel]:approval}});
   return {...base,title,price,status:'READY',token:approval.token,message:'停止対象を確認しました。'};
  }
  const a=current.approvals?.[channel];if(!a||a.token!==token||a.actor!==actor||a.operation!=='STOP'||a.expiresAt<Date.now()||a.fingerprint!==current.save.fingerprint||!a.title||typeof a.price!=='number')return base;
  const result=await runEconveniCommand(store,session,{inventoryId:id,channel,operation:'STOP',fingerprint:a.fingerprint,title:a.title,price:a.price,allowMercariRemoval:true});
  return {...base,title:a.title,status:result.channels[channel].state==='SUCCEEDED'?'DONE':'BLOCKED',message:result.channels[channel].state==='SUCCEEDED'?'停止結果を確認しました。':'停止結果が未確認です。重複送信していません。'};
 });}catch(e){return {...base,...econveniFailure(e)};}
}
