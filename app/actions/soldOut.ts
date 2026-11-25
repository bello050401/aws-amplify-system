'use server';
import {revalidatePath} from 'next/cache';
import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {inventoryDdb,inventoryTable,getInventoryRaw} from '@/lib/inventory/categoryPersistence';
import {listCategories} from '@/lib/inventory/queries';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {serverDataClient,inventoryAuthMode} from '@/lib/amplify/dataClient';
import {createSoldOutService} from '@/lib/inventory/soldOutCore';
import {copySoldOutPhotos,discardSoldOutPhotos} from '@/lib/inventory/soldOutPhotos';
import {SoldOutError,validateSoldOut,type SoldOutRequest,type SoldOutResult} from '@/lib/inventory/soldOutInput';
import {verifyUnlistedSale} from '@/lib/inventory/unlistedSaleGuard';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {candidateStore,candidateConfig} from '@/lib/saleCandidates/store';
import type {SaleCandidate} from '@/lib/saleCandidates/model';
import {yahooPaymentPlan} from '@/lib/saleCandidates/yahooPaymentModel';
import {ensureAutomaticSaleBinding} from '@/lib/saleCandidates/saleBinding';
import {refreshSaleBinding} from '@/lib/listing/econveni/saleAdjustment';
import {verifyMercariSale} from '@/lib/saleCandidates/desktopJobs';
import {automationStockOwner,claimAutomationStock,automationStockGuard,unlistedSaleStockGuard} from '@/lib/saleCandidates/automationStockLock';

export async function registerSoldOut(request:SoldOutRequest):Promise<{ok:true;result:SoldOutResult}|{ok:false;code:string;error:string}> {
  if((await getInventoryRole())!=='ADMIN')return {ok:false,code:'FORBIDDEN',error:'売却は管理者のみ実行できます。'};
  const verified=await inventoryMutationSession();
  if(verified?.role!=='ADMIN')return {ok:false,code:'FORBIDDEN',error:'売却は管理者のみ実行できます。'};
  const actor=verified.owner;
  if(!actor)return {ok:false,code:'FORBIDDEN',error:'再ログインしてください。'};
  try {
    validateSoldOut(request,undefined,request?.market);
    let candidate:SaleCandidate|undefined;
    if(request.sourceCandidateId){
      if(!/^[a-f0-9]{64}$/.test(request.sourceCandidateId))throw new SoldOutError('INVALID','購入通知を選び直してください。');
      candidate=await candidateStore().get(request.sourceCandidateId);
      if(!candidate||candidate.state==='DELETED')throw new SoldOutError('CONFLICT','この購入通知は削除されています。');
      if(request.withoutEconveniListing===true&&candidate.channel!=='DIRECT')throw new SoldOutError('INVALID','オンラインの購入通知ではeコンビニに出品しない登録はできません。');
      const expectedMarket=({BASE:'ベイス',MERCARI:'メルカリSHOP',YAHOO:'ヤフオク'} as Record<string,string>)[candidate.channel];
      if(expectedMarket&&request.market!==expectedMarket)throw new SoldOutError('INVALID','購入通知の販売先は変更できません。通知を確認してください。');
      if(candidate.state==='DONE'&&candidate.result){
        if((request.withoutEconveniListing===true)!==(candidate.result.withoutEconveniListing===true))throw new SoldOutError('CONFLICT','登録済みの売却方法は変更できません。商品を開き直してください。');
        return {ok:true,result:candidate.result};
      }
    }
    const stockOwner=await automationStockOwner(inventoryDdb,candidateConfig().tableName,request.inventoryId);
    if(stockOwner&&stockOwner!==candidate?.id&&!(request.withoutEconveniListing===true&&!candidate))throw new SoldOutError('CONFLICT','同じ在庫の前の売却処理が未完了です。販売先の処理結果を先に確認してください。');
    if(candidate&&!await claimAutomationStock(inventoryDdb,candidateConfig().tableName,request.inventoryId,candidate.id))throw new SoldOutError('CONFLICT','同じ在庫の前の売却処理が未完了です。');
    const channel=candidate?.channel==='MERCARI'?'MERCARI_SHOPS':candidate?.channel;
    const linked=request.withoutEconveniListing===true?true:channel&&channel!=='DIRECT'&&candidate?.externalListingId
      ?await ensureAutomaticSaleBinding(request.inventoryId,channel,candidate.externalListingId,actor)
      :!!await refreshSaleBinding(request.inventoryId);
    if(!linked)throw new SoldOutError('INVALID','売却登録の前にeコンビニと商品を紐付け、最新の出品IDを確認してください。');
    if(candidate?.channel==='MERCARI'){
      const inventory=await getInventoryRaw(request.inventoryId);
      if(!inventory||inventory.updatedAt!==request.expectedUpdatedAt)throw new SoldOutError('CONFLICT','在庫が変更されています。商品を開き直してください。');
      const verification=await verifyMercariSale(candidate,inventory);
      if(verification.status!=='DONE')throw new SoldOutError('INVALID','接続中のパソコンでメルカリShopsの商品名と写真を確認してください。確認依頼は重複せず保持しています。');
    }
    const execute=createSoldOutService({verifyUnlisted:verifyUnlistedSale,yahooPayment:yahooPaymentPlan(candidate),db:inventoryDdb,table:inventoryTable,categories:listCategories,copyPhotos:copySoldOutPhotos,discardPhotos:discardSoldOutPhotos,nextSku:async()=>{
      const result=await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if(!result.data||result.errors?.length)throw Error('管理番号を作成できませんでした。');return result.data;
    },...(candidate||request.withoutEconveniListing===true?{saleCommit:(result:SoldOutResult,now:string)=>[...(request.withoutEconveniListing===true?unlistedSaleStockGuard(candidateConfig().tableName,request.inventoryId,candidate?.id):automationStockGuard(candidateConfig().tableName,request.inventoryId,candidate!.id)),...(candidate?candidateStore().commit(candidate,actor,result,now):[])]}:{})});
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
