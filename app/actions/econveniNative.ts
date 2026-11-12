'use server';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserSub} from '@/lib/amplify/requireInventoryUser';
import {reviewNative,enqueueNative,nativeJobStatus,nativeShared,recheckNative} from '@/lib/listing/econveni/nativeQueue';
import {wakeNative} from '@/lib/listing/econveni/nativeWake';
import type {NativeRequest} from '@/lib/listing/econveni/nativeModel';
async function authorize(){const [role,actor]=await Promise.all([getInventoryRole(),getCurrentInventoryUserSub()]);if(!actor||!canEditInventory(role))throw Error('編集権限のあるアカウントでログインしてください。');return actor;}
function validate(r:NativeRequest){if(!/^[a-f0-9-]{36}$/i.test(r.inventoryId??'')||!/^\d{1,15}$/.test(r.productId??'')||!['BASE','YAHOO','MERCARI_SHOPS'].includes(r.channel)||!['PUBLISH','CLEAR','STOP'].includes(r.operation))throw Error('商品と操作を確認してください。');}
const message=(e:unknown)=>e instanceof Error&&/[ぁ-んァ-ン一-龯]/.test(e.message)?e.message:'処理できませんでした。再読み込みして確認してください。';
export async function reviewEconveniNativeAction(requests:NativeRequest[]){
 await authorize();if(!requests.length||requests.length>50)throw Error('一度に50件まで選択してください。');
 const results=[],shared=await nativeShared();
 for(let offset=0;offset<requests.length;offset+=5)results.push(...await Promise.all(requests.slice(offset,offset+5).map(async r=>{try{validate(r);return {ok:true as const,review:await reviewNative(r,shared)};}catch(e){return {ok:false as const,request:r,message:message(e)};}})));
 return results;
}
export async function enqueueEconveniNativeBatchAction(requests:Parameters<typeof enqueueEconveniNativeAction>[0][]){
 const actor=await authorize();if(!requests.length||requests.length>50)throw Error('一度に50件まで選択してください。');
 if(new Set(requests.map(r=>r.productId+':'+r.channel)).size!==requests.length)throw Error('対象が重複しています。');
 const shared=await nativeShared(),results=[];
 for(let offset=0;offset<requests.length;offset+=5)results.push(...await Promise.all(requests.slice(offset,offset+5).map(async request=>{try{validate(request);const j=await enqueueNative(request,actor,shared);return {ok:true as const,id:j.id};}catch(e){return {ok:false as const,message:message(e)};}})));
 if(results.some(r=>r.ok))await wakeNative();return results;
}
export async function enqueueEconveniNativeAction(request:NativeRequest&{requestId:string;fingerprint:string;inventoryVersion:string;confirmed:boolean;terms:boolean}){
 try{const actor=await authorize();validate(request);const j=await enqueueNative(request,actor);await wakeNative();return {ok:true as const,id:j.id};}catch(e){return {ok:false as const,message:message(e)};}
}
export async function econveniNativeStatusAction(ids:string[]){await authorize();return nativeJobStatus(ids);}
export async function recheckEconveniNativeAction(id:string){await authorize();try{const result=await recheckNative(id);await wakeNative();return {ok:true,message:result};}catch(e){return {ok:false,message:message(e)};}}
