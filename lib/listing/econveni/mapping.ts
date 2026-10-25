import {createHash} from 'node:crypto';
import {commonCategory,commonChannelPrice} from '../commonSettings';
import {listingQuantity} from '../quantity';
import type {ListingDraftRecord,ChannelListingRecord} from '../types';
import {restoreYahooAuctionInput,yahooPreparationIssues,type YahooAuctionSaved} from '../yahooAuction/preparation';

export class EconveniPreparationError extends Error {}
const yahooConditions={NEW:'new',LIKE_NEW:'used10',NO_NOTABLE_DAMAGE:'used20',SLIGHT_DAMAGE:'used40',DAMAGE:'used60',BAD:'used80'};
const shopsConditions={NEW:'CONDITION_BRAND_NEW',LIKE_NEW:'CONDITION_ALMOST_NEW',NO_NOTABLE_DAMAGE:'CONDITION_CLEAN',SLIGHT_DAMAGE:'CONDITION_LITTLE_DIRTY',DAMAGE:'CONDITION_DIRTY',BAD:'CONDITION_BAD'};
const html=(v:string)=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\r?\n/g,'<br>');
export function prepareEconveniProduct(draft:ListingDraftRecord,available:number,code:string,shops:ChannelListingRecord|null,yahoo:YahooAuctionSaved|null,now=Date.now()){
  const input=restoreYahooAuctionInput(draft,yahoo);
  input.quantity=listingQuantity(draft,available);
  const issues=yahooPreparationIssues(input,draft.images.length,available,now);
  if(input.format!=='FIXED')issues.push('eコンビニ経由のヤフオクは定額販売を選択してください。');
  if(input.quantity>9||input.quantity<1)issues.push('共通の出品数量は1〜9点で指定してください。');
  const category=commonCategory(draft.commonCategoryId)?.mercari?.id??shops?.categoryMapping?.mercariCategoryId;
  const price=commonChannelPrice(draft,'MERCARI_SHOPS',shops?.overridePrice);
  if(!category)issues.push('共通の商品情報で商品カテゴリを選択してください。');
  if(!price)issues.push('メルカリShopsの出品価格を入力してください。');
  if(price&&(!Number.isSafeInteger(price)||price<300||price>9999999))issues.push('メルカリShopsの出品価格は300〜9,999,999円で指定してください。');
  if(/[\r\n:]/.test(code))issues.push('管理番号に改行・コロンが含まれているため、eコンビニの商品コードへ保存できません。');
  if(!draft.condition)issues.push('商品の状態を選択してください。');
  const shipping=shops?.categoryMapping;
  if(shipping?.mercariShippingMethod&&shipping.mercariShippingMethod!==1)issues.push('メルカリShopsの配送方法は通常配送を選択してください。');
  // Never silently substitute a configured exceptional shipping rule with the normal profile.
  if(shipping?.mercariShippingPayer&&shipping.mercariShippingPayer!==1||shipping?.mercariShippingOriginArea&&shipping.mercariShippingOriginArea!=='jp11'||shipping?.mercariShippingDays&&shipping.mercariShippingDays!==3)
    issues.push('メルカリShopsの例外配送設定はeコンビニの通常配送設定と一致しません。設定を確認してください。');
  let duration=1,closingHour=21;
  if(input.automaticEnd===false){
    const today=new Date(now+9*3600000).toISOString().slice(0,10);
    duration=Math.round((Date.parse(input.endAtJst.slice(0,10)+'T00:00:00+09:00')-Date.parse(today+'T00:00:00+09:00'))/86400000);
    closingHour=Number(input.endAtJst.slice(11,13));
    if(duration<1||duration>8)issues.push('ヤフオクの終了日は明日から8日以内で指定してください。');
  }
  if(issues.length)throw new EconveniPreparationError([...new Set(issues)].join(' '));
  const quantity=input.quantity;
  const fields:Record<string,string>={products_name:input.title,products_description:html(input.description),products_quantity:String(quantity),
    products_price:String(input.priceYen),products_willprice:String(input.priceYen),products_category:input.categoryId,
    object:'',mercariShops_name:shops?.overrideTitle?.trim()||draft.title,
    mercariShops_description:shops?.overrideDescription?.trim()||draft.description||'',mercariShops_categoryId:category!,
    mercariShops_brandId:shipping?.mercariBrandId??'',mercariShops_variants:`:${quantity}:${code}:`,
    mercariShops_condition:shopsConditions[draft.condition!],mercariShops_price:String(price)};
  const option={condition:yahooConditions[input.condition!],duration,closingHour,autoExtension:input.autoExtension};
  const shippingLabel=(input.shippingMethod??draft.shippingMethod)==='SAGAWA'?'佐川急便':'家財おまかせ便';
  const refs=[...draft.images].sort((a,b)=>a.sortOrder-b.sortOrder);
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,fields,option,shippingLabel,refs})).digest('hex');
  return {fields,option,shippingLabel,refs,fingerprint,quantity};
}
