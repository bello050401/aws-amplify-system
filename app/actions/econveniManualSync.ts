'use server';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserSub} from '@/lib/amplify/requireInventoryUser';
import {readManualSync,refreshManualSync,linkExternalProduct,unlinkExternalProduct,productFingerprint} from '@/lib/listing/econveni/manualSync';
import {listListingsOverview} from '@/lib/listing/service';
import {econveniFailure} from '@/lib/listing/econveni/service';
import type {ManualSyncData} from '@/lib/listing/econveni/manualSyncModel';
export type ManualSyncResult={ok:true;data:ManualSyncData;fingerprints:Record<string,string>}|{ok:false;message:string};
export async function econveniManualSyncAction(input:{action:'load'|'refresh'|'link'|'unlink';inventoryId?:string;productId?:string;version?:string;fingerprint?:string;confirmed?:boolean;revision?:number}):Promise<ManualSyncResult>{
 const role=await getInventoryRole(),actor=await getCurrentInventoryUserSub();
 if(!canEditInventory(role)||!actor)return {ok:false,message:'編集権限のあるアカウントでログインしてください。'};
 try{
  if(!['load','refresh','link','unlink'].includes(input.action))throw Error('操作を確認してください。');
  let data:ManualSyncData;
  if(input.action==='link'||input.action==='unlink'){
   if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.inventoryId??''))throw Error('対象商品を確認してください。');
   if(input.action==='link'){
    const row=(await listListingsOverview()).find(r=>r.inventoryId===input.inventoryId);
    if(!row||row.archived||!row.categories?.some(c=>c==='販売中'||c==='出品中'))throw Error('「販売中・出品中」の在庫を選択してください。');
    data=await linkExternalProduct({inventoryId:input.inventoryId!,productId:input.productId??'',version:input.version??'',fingerprint:input.fingerprint??'',confirmed:input.confirmed===true},actor);
   }else {if(input.confirmed!==true)throw Error('解除内容を確認してください。');data=await unlinkExternalProduct(input.inventoryId!,Number(input.revision),actor);}
  }else data=await (input.action==='refresh'?refreshManualSync():readManualSync());
  return {ok:true,data,fingerprints:Object.fromEntries((data.snapshot?.products??[]).map(p=>[p.productId,productFingerprint(p)]))};
 }catch(e){return {ok:false,message:e instanceof Error&&/[ぁ-んァ-ン一-龯]/.test(e.message)?e.message:econveniFailure(e).message};}
}
