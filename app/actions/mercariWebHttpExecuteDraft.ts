"use server";
import {getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {executeMercariHttpDraftStep,type DraftStepResult} from '@/lib/listing/mercariBridge/executeDraftStep';
import {prepareMercariWebHttpDraftJobAction} from './mercariWebHttpDraftJob';
export type {DraftStepResult} from '@/lib/listing/mercariBridge/executeDraftStep';
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
export async function executeMercariHttpDraftStepAction(requestId:string):Promise<DraftStepResult>{
 if(process.env.BELLO_LEGACY_EC_DIRECT_WRITES!=='1')return {status:'UNAVAILABLE',nextEligibleAtMs:null};
 if(await getInventoryRole()!=='ADMIN')return {status:'UNAVAILABLE',nextEligibleAtMs:null};
 const principal=await getCurrentInventoryUserEmail();if(!principal)return {status:'UNAVAILABLE',nextEligibleAtMs:null};
 return executeMercariHttpDraftStep(requestId,principal,async job=>{
  const {pack}=JSON.parse(job.snapshotJson);
  const current=await prepareMercariWebHttpDraftJobAction(job.inventoryId,{priceYen:pack.priceYen,quantity:pack.quantity,categoryId:pack.categoryId,brandId:pack.brandId,shippingMethod:pack.shipping.method,descriptionSuffix:pack.descriptionSuffix});
  return current.ok&&JSON.stringify(stable(current.pack))===JSON.stringify(stable(pack));
 });
}
