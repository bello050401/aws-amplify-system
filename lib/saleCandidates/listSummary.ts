import 'server-only';
import {inventoryAuthMode,serverDataClient} from '../amplify/dataClient';
import type {SaleCandidate} from './model';
import {readCurrentSaleSummaryBatch} from './summaryRead';

// Candidate cards need six current sale fields, never original images or purchase/customer data.
// Batch only after verified administrator authorization. AppSync remains the
// fallback for unavailable/incomplete batches; neither path caches sale values.
export async function withCurrentSaleSummary(candidates:SaleCandidate[]):Promise<SaleCandidate[]>{
 const selectionSet=['name','salePrice','saleCommission','saleEndDate','externalProductId','deletedAt'] as const;
 const read=(id:string)=>serverDataClient.models.Inventory.get({id},{...inventoryAuthMode,selectionSet});
 const pending=new Map<string,ReturnType<typeof read>>();
 const target=(candidate:SaleCandidate)=>candidate.state==='DONE'?candidate.result?.soldId:candidate.source==='INVOICE'&&!candidate.name?candidate.suggestedInventoryId:undefined;
 const batch=await readCurrentSaleSummaryBatch(candidates.flatMap(c=>{const id=target(c);return id?[id]:[]}));
 return Promise.all(candidates.map(async candidate=>{
  const id=target(candidate);
  if(!id)return candidate;
  let result;
  if(batch)result={data:batch.get(id)??null,errors:undefined};
  else {let request=pending.get(id);if(!request){request=read(id);pending.set(id,request);}result=await request;}
  if(result.errors?.length)throw Error('SALE_SUMMARY_UNAVAILABLE');
  const item=result.data&&!result.data.deletedAt?result.data:null;
  return {...candidate,name:item?.name||candidate.name||'請求書の商品（在庫を再選択してください）',...(candidate.state==='DONE'&&item?{completedSale:{quantity:candidate.result!.soldQuantity,total:item.salePrice??null,commission:item.saleCommission??null,date:item.saleEndDate||'',identifier:item.externalProductId||''}}:{})};
 }));
}
