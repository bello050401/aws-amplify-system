"use server";
import { canEditInventory, getInventoryRole } from '@/lib/amplify/requireInventoryUser';
import { getListingDraftForInventory } from '@/lib/listing/service';
import { getInventoryDetail } from '@/lib/inventory/queries';
import { commonCategory, commonChannelPrice } from '@/lib/listing/commonSettings';
import { listingQuantity } from '@/lib/listing/quantity';
import { restoreYahooAuctionInput, yahooSourceMatches, yahooPreparationIssues } from '@/lib/listing/yahooAuction/preparation';
import { getYahooAuctionPreparationAction, saveYahooAuctionPreparationAction } from './yahooAuctionPreparation';
import { prepareMercariWebHttpDraftJobAction, reserveMercariWebHttpDraftJobAction } from './mercariWebHttpDraftJob';

/** Prepare from saved common fields; these actions only write BELLO drafts. */
export async function ensureYahooCommonPreparationAction(id:string) {
  const context=await getYahooAuctionPreparationAction(id);
  if(!context.ok) return {ok:false as const,message:'ヤフオクの保存情報を取得できません。'};
  const {draft,saved,availableQuantity,canPrepare}=context.context;
  if(!draft||!canPrepare)return {ok:false as const,message:'共通の商品情報と在庫数を確認してください。'};
  if(saved&&yahooSourceMatches(saved.payload.source,draft))return {ok:true as const,saved};
  const input=restoreYahooAuctionInput(draft,saved);
  input.quantity=listingQuantity(draft,availableQuantity);
  const issues=yahooPreparationIssues(input,draft.images.length,availableQuantity);
  if(input.quantity>9)issues.push('ヤフオクの出品数量は9点までです。共通の出品数量を確認してください。');
  if(issues.length)return {ok:false as const,message:issues.join(' ')};
  const result=await saveYahooAuctionPreparationAction(id,input,saved?.revision??null,draft.updatedAt);
  return result.ok?result:{ok:false as const,message:'出品準備の保存を確認できません。再確認してください。'};
}

export async function prepareMercariFromCommonAction(id:string) {
  if(!canEditInventory(await getInventoryRole()))return {ok:false as const,message:'編集権限を確認してください。'};
  const [draft,item]=await Promise.all([getListingDraftForInventory(id),getInventoryDetail(id)]);
  if(!draft||!item)return {ok:false as const,message:'共通の商品情報を保存してください。'};
  const category=commonCategory(draft.commonCategoryId)?.mercari;
  const price=commonChannelPrice(draft,'MERCARI_SHOPS');
  if(!category)return {ok:false as const,message:'共通の商品情報で商品カテゴリを選択してください。'};
  if(!price)return {ok:false as const,message:'共通の商品情報でメルカリShopsの価格を設定してください。'};
  const prepared=await prepareMercariWebHttpDraftJobAction(id,{priceYen:price,quantity:listingQuantity(draft,item.quantity),
    categoryId:category.id,brandId:null,shippingMethod:'METHOD_TYPE_UNDECIDED'});
  if(!prepared.ok)return {ok:false as const,message:'共通の商品情報の価格・数量・画像・カテゴリを確認してください。'};
  const result=await reserveMercariWebHttpDraftJobAction(prepared.pack,true);
  return result.ok?{ok:true as const}:{ok:false as const,message:'メルカリShopsの準備を保存できませんでした。保存情報を再確認してください。'};
}
