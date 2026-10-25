'use server';
import {revalidatePath} from 'next/cache';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {createStockSplitService} from '@/lib/inventory/stockSplitCore';
import {StockSplitError,type StockSplitRequest,type StockSplitResult} from '@/lib/inventory/stockSplitInput';
import {copySoldOutPhotos,discardSoldOutPhotos} from '@/lib/inventory/soldOutPhotos';
import {serverDataClient,inventoryAuthMode} from '@/lib/amplify/dataClient';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
export async function registerStockSplit(request:StockSplitRequest):Promise<{ok:true;result:StockSplitResult}|{ok:false;code:string;error:string}>{
 const session=await inventoryMutationSession();
 if(!session)return {ok:false,code:'FORBIDDEN',error:'在庫を分ける権限がありません。'};
 try {
  const execute=createStockSplitService({db:inventoryDdb,table:inventoryTable,copyPhotos:copySoldOutPhotos,discardPhotos:discardSoldOutPhotos,nextSku:async()=>{
   const result=await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);if(!result.data||result.errors?.length)throw Error('管理番号を作成できませんでした。');return result.data;
  }});
  const result=await execute(request,session.owner);clearInventoryCountCache();
  revalidatePath('/inventory');revalidatePath('/inventory/'+result.sourceId);revalidatePath('/inventory/'+result.splitId);
  return {ok:true,result};
 }catch(error){
  if(error instanceof StockSplitError)return {ok:false,code:error.code,error:error.message};
  console.error('[stock-split]',error instanceof Error?error.name:'UnknownError');
  return {ok:false,code:'UNCONFIRMED',error:'保存結果を確認できません。同じ内容で結果を再確認してください。'};
 }
}
