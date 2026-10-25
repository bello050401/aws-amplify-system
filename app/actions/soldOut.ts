'use server';
import {revalidatePath} from 'next/cache';
import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {listCategories} from '@/lib/inventory/queries';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {serverDataClient,inventoryAuthMode} from '@/lib/amplify/dataClient';
import {createSoldOutService} from '@/lib/inventory/soldOutCore';
import {copySoldOutPhotos,discardSoldOutPhotos} from '@/lib/inventory/soldOutPhotos';
import {SoldOutError,type SoldOutRequest,type SoldOutResult} from '@/lib/inventory/soldOutInput';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {candidateStore} from '@/lib/saleCandidates/store';
import type {SaleCandidate} from '@/lib/saleCandidates/model';

export async function registerSoldOut(request:SoldOutRequest):Promise<{ok:true;result:SoldOutResult}|{ok:false;code:string;error:string}> {
  if((await getInventoryRole())!=='ADMIN')return {ok:false,code:'FORBIDDEN',error:'売却は管理者のみ実行できます。'};
  const verified=await inventoryMutationSession();
  if(verified?.role!=='ADMIN')return {ok:false,code:'FORBIDDEN',error:'売却は管理者のみ実行できます。'};
  const actor=verified.owner;
  if(!actor)return {ok:false,code:'FORBIDDEN',error:'再ログインしてください。'};
  try {
    let candidate:SaleCandidate|undefined;
    if(request.sourceCandidateId){
      if(!/^[a-f0-9]{64}$/.test(request.sourceCandidateId))throw new SoldOutError('INVALID','購入通知を選び直してください。');
      candidate=await candidateStore().get(request.sourceCandidateId);
      if(!candidate||candidate.state==='DELETED')throw new SoldOutError('CONFLICT','この購入通知は削除されています。');
      if(candidate.state==='DONE'&&candidate.result)return {ok:true,result:candidate.result};
    }
    const execute=createSoldOutService({db:inventoryDdb,table:inventoryTable,categories:listCategories,copyPhotos:copySoldOutPhotos,discardPhotos:discardSoldOutPhotos,nextSku:async()=>{
      const result=await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if(!result.data||result.errors?.length)throw Error('管理番号を作成できませんでした。');return result.data;
    },...(candidate?{saleCommit:(result:SoldOutResult,now:string)=>candidateStore().commit(candidate!,actor,result,now)}:{})});
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
