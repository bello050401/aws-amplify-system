'use server';
import {revalidatePath} from 'next/cache';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {listCategories} from '@/lib/inventory/queries';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {serverDataClient,inventoryAuthMode} from '@/lib/amplify/dataClient';
import {createSoldOutService} from '@/lib/inventory/soldOutCore';
import {copySoldOutPhotos,discardSoldOutPhotos} from '@/lib/inventory/soldOutPhotos';
import {SoldOutError,type SoldOutRequest,type SoldOutResult} from '@/lib/inventory/soldOutInput';

export async function registerSoldOut(request:SoldOutRequest):Promise<{ok:true;result:SoldOutResult}|{ok:false;code:string;error:string}> {
  if(!canEditInventory(await getInventoryRole()))return {ok:false,code:'FORBIDDEN',error:'在庫を編集する権限がありません。'};
  const actor=await getCurrentInventoryUserEmail();
  if(!actor)return {ok:false,code:'FORBIDDEN',error:'再ログインしてください。'};
  try {
    const execute=createSoldOutService({db:inventoryDdb,table:inventoryTable,categories:listCategories,copyPhotos:copySoldOutPhotos,discardPhotos:discardSoldOutPhotos,nextSku:async()=>{
      const result=await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if(!result.data||result.errors?.length)throw Error('管理番号を作成できませんでした。');return result.data;
    }});
    const result=await execute(request,actor);
    clearInventoryCountCache();
    revalidatePath('/inventory'); revalidatePath(`/inventory/${result.sourceId}`); revalidatePath(`/inventory/${result.soldId}`);
    return {ok:true,result};
  }catch(error){
    if(error instanceof SoldOutError)return {ok:false,code:error.code,error:error.message};
    console.error('[sold-out]',error instanceof Error?error.name:'UnknownError');
    return {ok:false,code:'UNCONFIRMED',error:'登録結果を確認できません。同じ内容で「登録結果を再確認」を押してください。'};
  }
}
