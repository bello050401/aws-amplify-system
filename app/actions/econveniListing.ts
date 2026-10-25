"use server";
import {canEditInventory,getInventoryRole,getCurrentInventoryUserSub} from '@/lib/amplify/requireInventoryUser';
import {saveEconveniDraft,econveniOperation,type EconveniSaveResult} from '@/lib/listing/econveni/service';
import {revalidatePath} from 'next/cache';
import type {EcReview} from '@/lib/listing/ecManagement';
const valid=(id:string)=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export async function saveEconveniDraftAction(id:string):Promise<EconveniSaveResult>{
  if(!valid(id)||!canEditInventory(await getInventoryRole()))return {status:'BLOCKED',message:'編集権限を確認してください。'};
  const result=await saveEconveniDraft(id);revalidatePath('/inventory/listings');return result;
}
export async function econveniListingAction(id:string,channel:'YAHOO'|'MERCARI_SHOPS',operation:'PUBLISH'|'STOP',token?:string,terms=false):Promise<EcReview>{
  const actor=await getCurrentInventoryUserSub();
  if(!actor||!valid(id)||!['YAHOO','MERCARI_SHOPS'].includes(channel)||!['PUBLISH','STOP'].includes(operation)||!canEditInventory(await getInventoryRole()))return {inventoryId:id,title:'',channel,operation,status:'BLOCKED',message:'操作権限を確認してください。'};
  const result=await econveniOperation(id,channel,operation,actor,token,terms);revalidatePath('/inventory/listings');return result;
}
