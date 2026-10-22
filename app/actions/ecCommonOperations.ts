"use server";
import { createHash } from 'node:crypto';
import { canEditInventory,getInventoryRole } from '@/lib/amplify/requireInventoryUser';
import { getInventoryDetail } from '@/lib/inventory/queries';
import { getListingDraftForInventory } from '@/lib/listing/service';
import { ensureYahooCommonPreparationAction } from './commonEcPreparation';
import { getYahooWorkflowAction,cancelYahooListingAction,startNewYahooPublicationAction,
 prepareYahooPublicationAction,publishYahooListingAction } from './yahooAuctionWorkflow';
import type { EcReview } from '@/lib/listing/ecManagement';
import { commonChannelPrice } from '@/lib/listing/commonSettings';
import { listingQuantity } from '@/lib/listing/quantity';

export async function commonOperationSourceHash(id:string) {
  if(!canEditInventory(await getInventoryRole()))throw Error('FORBIDDEN');
  const [draft,item]=await Promise.all([getListingDraftForInventory(id),getInventoryDetail(id)]);
  if(!draft||!item)throw Error('SOURCE');
  return createHash('sha256').update(JSON.stringify([id,draft.id,draft.updatedAt,item.updatedAt])).digest('hex');
}

/** Yahoo cannot edit an open fixed-price listing: an explicit update confirmation
 * covers fee-free cancellation and a new listing, using the existing durable workflow. */
export async function commonYahooUpdateAction(id:string,token:string|null,terms=false):Promise<Partial<EcReview>> {
  const blocked=(message:string):Partial<EcReview>=>({status:'BLOCKED',message});
  if(!canEditInventory(await getInventoryRole()))return blocked('編集権限を確認してください。');
  const source=await commonOperationSourceHash(id);
  const [draft,item,current]=await Promise.all([getListingDraftForInventory(id),getInventoryDetail(id),getYahooWorkflowAction(id)]);
  if(!draft||!item||!current.ok)return blocked('ヤフオクの商品情報を取得できません。');
  const listing=current.view.listing;
  type Approval={a:string|null;s:string;p:boolean;t:number};
  let approval:Approval;
  if(token===null){
    approval={a:listing?.auctionId??null,s:source,p:listing?.remoteStatus==='open',t:Date.now()};
    const preparation=await ensureYahooCommonPreparationAction(id);
    if(!preparation.ok)return blocked(preparation.message);
    return {status:'READY',token:Buffer.from(JSON.stringify(approval)).toString('base64url'),requiresTerms:approval.p,
      title:preparation.saved.payload.input.title,price:commonChannelPrice(draft,'YAHOO'),quantity:listingQuantity(draft,item.quantity),imageCount:draft.images.length,
      message:approval.p?'現在の出品を停止し、保存した商品情報で新しく出品します。':'次回の出品に使う商品情報を更新します。現在の停止状態は保ちます。',
      details:approval.p?['入札・取消料金が発生する場合は停止します。','出品番号が変わります。変更後の商品名・価格・数量・画像で出品します。']:[]};
  }
  try {approval=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));}catch{return blocked('確認内容を読み直してください。');}
  if(!approval||approval.s!==source||typeof approval.p!=='boolean'||!Number.isFinite(approval.t)||Date.now()-approval.t>15*60_000||approval.t>Date.now()+1000)
    return blocked('商品情報が変わったか、確認期限が切れました。確認し直してください。');
  if(approval.p&&!terms)return blocked('ヤフオクの規約と停止・新規出品を確認してください。');
  const prepared=await ensureYahooCommonPreparationAction(id);
  if(!prepared.ok)return blocked(prepared.message);
  if(!approval.p)return {status:'DONE',message:'次回の出品情報を更新しました。出品停止中です。'};
  if(!approval.a||!listing)return blocked('対象の出品状態が変わりました。');
  if(listing.auctionId!==approval.a){
    const replaced=current.view.previousListings.some(p=>p.auctionId===approval.a&&p.remoteStatus==='cancelled');
    return replaced&&listing.remoteStatus==='open'&&Date.parse(listing.checkedAt)>=approval.t
      ?{status:'DONE',message:'変更した内容で出品し直しました。'}:blocked('出品番号が変わりました。状態を確認してください。');
  }
  const wait=(message:string,nextAt=Date.now()+1000):Partial<EcReview>=>({status:'WAIT',token,nextAt,message});
  const failed=(r:{code:string;waitUntil?:number})=>r.code==='WAIT_INTERVAL'?wait('販売先への送信間隔を空けています。',r.waitUntil):blocked(`ヤフオクの更新を中断しました（${r.code}）。出品状態を確認してください。`);
  if(listing.remoteStatus==='open'){
    const stopped=await cancelYahooListingAction(id,listing.auctionId);
    if(!stopped.ok)return failed(stopped);
    if(stopped.view.listing?.remoteStatus!=='cancelled')return blocked('停止結果を確認できません。自動再出品は行いません。');
    return wait('停止を確認しました。変更後の画像と商品情報を準備します。');
  }
  if(listing.remoteStatus!=='cancelled')return blocked('販売状況が変わりました。自動再出品は行いません。');
  if(current.view.stage==='IDLE'){
    const started=await startNewYahooPublicationAction(id,listing.auctionId,prepared.saved.revision);
    return started.ok?wait('新しい画像で出品準備を開始しました。'):failed(started);
  }
  const result=await prepareYahooPublicationAction(id,prepared.saved.revision);
  if(!result.ok)return failed(result);
  if(result.view.stage==='PREPARING')return wait(`画像を準備中（${result.view.uploaded}/${result.view.imageCount}枚）`,Math.max(Date.now()+1000,result.view.waitUntil));
  if(!result.view.confirmationId)return blocked('出品内容を確認できません。停止状態を保ちます。');
  if(await commonOperationSourceHash(id)!==source)return blocked('商品情報が変わりました。出品前に確認し直してください。');
  const published=await publishYahooListingAction(id,result.view.confirmationId,terms);
  if(!published.ok)return failed(published);
  return published.view.listing?.remoteStatus==='open'?{status:'DONE',message:'変更した内容で出品し直しました。'}:blocked('出品結果を確認できません。重複出品を防ぐため中断しました。');
}
