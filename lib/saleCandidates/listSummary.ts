import 'server-only';
import {inventoryAuthMode,serverDataClient} from '../amplify/dataClient';
import type {SaleCandidate} from './model';

// Only current sale amounts are returned to candidate cards, never full custom fields or images.
// Keep the existing authenticated AppSync boundary and deduplicate within this request only.
export async function withCurrentSaleSummary(candidates:SaleCandidate[]):Promise<SaleCandidate[]>{
 const selectionSet=['name','salePrice','saleCommission','saleEndDate','externalProductId','deletedAt','customFields'] as const;
 const read=(id:string)=>serverDataClient.models.Inventory.get({id},{...inventoryAuthMode,selectionSet});
 const pending=new Map<string,ReturnType<typeof read>>();
 return Promise.all(candidates.map(async candidate=>{
  const id=candidate.state==='DONE'?candidate.result?.soldId:candidate.source==='INVOICE'&&!candidate.name?candidate.suggestedInventoryId:undefined;
  if(!id)return candidate;
  let request=pending.get(id);if(!request){request=read(id);pending.set(id,request);}
  const result=await request;if(result.errors?.length)throw Error('SALE_SUMMARY_UNAVAILABLE');
  const item=result.data&&!result.data.deletedAt?result.data:null;
  let shippingReceived:number|null=null;
  try{const custom=typeof item?.customFields==='string'?JSON.parse(item.customFields):item?.customFields;const n=custom?.__belloSale?.shippingReceived;if(Number.isSafeInteger(n)&&n>=0)shippingReceived=n;}catch{}
  return {...candidate,name:item?.name||candidate.name||'請求書の商品（在庫を再選択してください）',...(candidate.state==='DONE'&&item?{completedSale:{quantity:candidate.result!.soldQuantity,total:item.salePrice??null,commission:item.saleCommission??null,shippingReceived,date:item.saleEndDate||'',identifier:item.externalProductId||''}}:{})};
 }));
}
