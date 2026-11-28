"use server";
import {getInventoryRole,getVerifiedInventoryAccess} from '@/lib/amplify/requireInventoryUser';
import {loadWholesale,saveWholesale,validWholesaleRequest} from '@/lib/listing/wholesaleServer';
import type {WholesaleSaveRequest} from '@/lib/listing/wholesale';
export async function loadWholesaleAction(){const role=await getInventoryRole();if(!role)throw Error('ログインしてください。');return loadWholesale(role);}
export async function saveWholesaleAction(request:WholesaleSaveRequest){
 if(!validWholesaleRequest(request))throw Error('選択内容を確認してください。');
 try{
  const access=await getVerifiedInventoryAccess();if(access.kind!=='authorized')throw Error('ログインしてください。');
  return await saveWholesale(access.role,access.owner??access.role,request);
 }catch(error){
  // saveWholesale contains every per-item write/result in its own catch. A
  // propagated error is a confirmed pre-write refusal, not an unknown commit.
  return {results:request.items.map(item=>({id:item.id,status:'failed' as const,message:error instanceof Error?error.message:'保存前の確認に失敗しました。'}))};
 }
}
