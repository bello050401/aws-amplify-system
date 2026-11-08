import {createHash} from 'node:crypto';
import {allocateFee,calculateFee,CHANNELS,type FeeConfig,type SaleCandidate} from './model';
import {yahooPaymentPlan} from './yahooPaymentModel';
import type {SoldOutRequest} from '../inventory/soldOutInput';

export type AutomationReason='NOT_UNIQUE'|'NO_ITEM_ID'|'QUANTITY_UNKNOWN'|'SET_REVIEW'|'ORDER_REVIEW'|'UNTRUSTED_MAIL'|'STOCK_CHANGED'|'WAITING_PAYMENT'|'CANCELLED'|'HISTORICAL'|'CHANNEL_UNSUPPORTED';
export const AUTOMATION_REASONS:Record<AutomationReason,string>={
 NOT_UNIQUE:'出品IDに対応する在庫が一意ではありません。商品を選択してください。',NO_ITEM_ID:'通知には商品IDがありません。画像と商品名を確認して紐付けてください。',
 QUANTITY_UNKNOWN:'売却点数を通知から確定できません。数量を確認してください。',SET_REVIEW:'セット販売の構成点数を確認してください。',ORDER_REVIEW:'注文状態・送料・金額を確認してください。',
 UNTRUSTED_MAIL:'受信元の認証を確認できない通知です。自動処理しません。',STOCK_CHANGED:'在庫・販売情報が変更されています。確認してください。',WAITING_PAYMENT:'入金待ちです。在庫数量は変更していません。',
 CANCELLED:'キャンセルされた注文です。在庫や出品を自動で戻さず確認してください。',HISTORICAL:'自動化の開始前の通知です。過去の売却との重複を確認してください。',CHANNEL_UNSUPPORTED:'この経路は手動で売却登録してください。',
};
export type AutomaticDecision={kind:'REVIEW';reason:AutomationReason}|{kind:'WAIT';reason:AutomationReason}|{kind:'SELL';request:SoldOutRequest};
export function stableSaleMutation(id:string){const h=createHash('sha256').update('BELLO_AUTO_SALE_V1:'+id).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}

/** No name similarity, SKU guessing, remaining-count inference, or hidden 1-item defaults. */
export function automaticSaleDecision(c:SaleCandidate,ids:string[],item:Record<string,unknown>|null,fees:FeeConfig,enabledAt:string):AutomaticDecision{
 const review=(reason:AutomationReason):AutomaticDecision=>({kind:'REVIEW',reason});
 if(c.state!=='PENDING')return review('STOCK_CHANGED');
 const orderAt=c.channel==='YAHOO'?(c.yahooEvents?.WON??c.receivedAt):c.receivedAt;
 if(!Number.isFinite(Date.parse(enabledAt))||!Number.isFinite(Date.parse(orderAt))||Date.parse(orderAt)<Date.parse(enabledAt))return review('HISTORICAL');
 if(c.source==='DIRECT'||c.source==='INVOICE'||c.channel==='DIRECT')return review('CHANNEL_UNSUPPORTED');
 if(c.source==='GMAIL'&&c.senderAuthenticated!==true)return review('UNTRUSTED_MAIL');
 if(!c.externalListingId)return review('NO_ITEM_ID');
 if(ids.length!==1||!item||item.id!==ids[0])return review('NOT_UNIQUE');
 if(item.isDeleted||item.deletedAt||!Number.isSafeInteger(item.quantity)||Number(item.quantity)<1||!item.updatedAt)return review('STOCK_CHANGED');
 if(c.quantity===null||!Number.isSafeInteger(c.quantity)||c.quantity<1)return review('QUANTITY_UNKNOWN');
 if(c.quantity>Number(item.quantity))return review('STOCK_CHANGED');
 // Bracketed inventory notes remain private; external sale titles still describe bundles.
 if(/セット|一山|\d+\s*(?:脚|点|台|個|枚)\s*(?:組|山)|ペア|pair|bundle|set\b/i.test(c.name))return review('SET_REVIEW');
 if(c.channel==='BASE'){
  if(c.source!=='BASE_API')return review('ORDER_REVIEW');
  if(c.baseDispatchStatus==='cancelled')return review('CANCELLED');
  if(['unpaid','unshippable'].includes(c.baseDispatchStatus??''))return {kind:'WAIT',reason:'WAITING_PAYMENT'};
  // COD/deferred billing is not proof of receipt of money.
  if(!['ordered','dispatched','shipping'].includes(c.baseDispatchStatus??'')||/cod|atobarai|後払|代引/i.test(c.payment))return review('ORDER_REVIEW');
  if(c.warnings.length||c.orderRoute==='UNKNOWN')return review('ORDER_REVIEW');
 }else if(c.channel==='YAHOO'){
  if(c.verifiedSaleFacts!==true||!c.yahooStatus||c.warnings.some(w=>/異なる|取引ナビで/.test(w)))return review('ORDER_REVIEW');
 }
 if(c.unitPrice===null||!Number.isSafeInteger(c.unitPrice)||c.unitPrice<0||c.shipping===null||!Number.isSafeInteger(c.shipping)||c.shipping<0)return review('ORDER_REVIEW');
 const price=c.unitPrice*c.quantity;if(!Number.isSafeInteger(price))return review('ORDER_REVIEW');
 let shipping=c.shipping,fee:number;
 if(c.orderLineCount>1){
  const a=c.feeAllocation;if(!a||a.amounts[a.index]!==price)return review('ORDER_REVIEW');
  shipping=allocateFee(c.shipping,a.amounts)[a.index];
 }
 if(c.channel==='BASE'&&c.confirmedLineFee!==undefined)fee=c.confirmedLineFee;
 else if(c.channel==='BASE'&&c.orderLineCount>1){const a=c.feeAllocation!;fee=allocateFee(calculateFee('BASE',a.amounts.reduce((n,v)=>n+v,0)+c.shipping,c.payment,fees,c.orderRoute==='PAY_ID_APP'),a.amounts)[a.index];}
 else fee=calculateFee(c.channel,price+(c.channel==='BASE'?shipping:0),c.payment,fees,c.orderRoute==='PAY_ID_APP');
 const yahoo=yahooPaymentPlan(c);
 return {kind:'SELL',request:{mutationId:stableSaleMutation(c.id),inventoryId:ids[0],expectedUpdatedAt:String(item.updatedAt),quantity:c.quantity,name:String(item.name),saleEndDate:yahoo?.waiting?'':c.saleDate,externalProductId:c.orderId,market:CHANNELS[c.channel].market,salePrice:price,saleCommission:fee,saleShippingReceived:shipping,sourceCandidateId:c.id,...(yahoo?.waiting?{awaitingYahooPayment:true}:{})}};
}
