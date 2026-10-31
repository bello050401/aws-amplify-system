import {GetCommand,QueryCommand,PutCommand,UpdateCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence} from '../inventory/categoryPersistenceCore';
import {inventoryCategoryIds} from '../inventory/categories';
import {parseCustomFields,stringifyCustomFields} from '../inventory/customFieldsCodecCore';
import {withHumanEdits} from '../inventory/humanEdits';
import type {SaleCandidate} from './model';
import {yahooPaymentPlan,paymentDate,yahooPaymentKey,YAHOO_PAYMENT_QUEUE_STATE} from './yahooPaymentModel';

type Queue={id:string;state:string;receivedAt:string;candidateId:string;auctionId:string;sourceId:string;soldId:string;soldQuantity:number};
const conflict=()=>Error('PAYMENT_INVENTORY_CONFLICT');
/** No sale/quantity/EC mutation is called here. Only the exact sold record from the atomic sale receipt is eligible. */
export function createYahooPaymentReconciler(db:DynamoDBDocumentClient,candidateTable:string,table:(name:string)=>string){
 const persistence=createInventoryPersistence(db,table);
 const get=async(id:string)=>(await db.send(new GetCommand({TableName:candidateTable,Key:{id},ConsistentRead:true}))).Item;
 async function settle(queue:Queue):Promise<'waiting'|'applied'|'skipped'> {
  const candidate=await get(queue.candidateId) as SaleCandidate|undefined;
  if(!candidate||candidate.state!=='DONE'||candidate.yahooPaymentState!=='WAITING')return 'skipped';
  const payment=yahooPaymentPlan(candidate);
  if(!payment||payment.waiting)return 'waiting';
  const receipt=candidate.result;
  if(queue.id!==yahooPaymentKey(candidate.id)||queue.state!==YAHOO_PAYMENT_QUEUE_STATE||queue.auctionId!==candidate.orderId||!receipt||receipt.soldId!==queue.soldId||receipt.sourceId!==queue.sourceId||receipt.soldQuantity!==queue.soldQuantity)throw conflict();
  const item=await persistence.getInventoryRaw(queue.soldId);
  const custom=parseCustomFields(item?.customFields),marker=custom?.__belloYahooPayment as Record<string,unknown>|undefined;
  if(!item||item.deletedAt||item.isDeleted||item.listingPartition==='MERGED'||item.outboundBatchId||item.outboundArrivalBatchId||item.quantity!==queue.soldQuantity||item.market!=='ヤフオク'||item.externalProductId!==queue.auctionId||item.saleEndDate||marker?.state!=='WAITING'||marker.candidateId!==candidate.id||marker.auctionId!==candidate.orderId||typeof marker.unpaidCategoryId!=='string')throw conflict();
  const before=inventoryCategoryIds(item);
  const categories=await Promise.all(before.map(id=>db.send(new GetCommand({TableName:table('Category'),Key:{id},ConsistentRead:true})).then(r=>r.Item)));
  if(!categories.every(Boolean)||categories.some(c=>['販売中','出品中'].includes(c!.name))||!categories.some(c=>c!.name==='売り切れ')||!categories.some(c=>c!.id===marker.unpaidCategoryId&&['入金待ち','未入金'].includes(c!.name)))throw conflict();
  const after=before.filter(id=>id!==marker.unpaidCategoryId);
  const now=new Date(Math.max(Date.now(),Date.parse(item.updatedAt)+1,Date.parse(candidate.updatedAt)+1)).toISOString();
  const changes={categoryId:after[0],categoryIds:after,saleEndDate:paymentDate(payment.paidAt!),updatedAt:now,listUpdatedAt:now,updatedBy:'ヤフオク入金確認'};
  const values={...changes,customFields:stringifyCustomFields({...withHumanEdits(item,changes,custom,custom??undefined),__belloYahooPayment:{...marker,state:'APPLIED',paidAt:payment.paidAt,appliedAt:now}})};
  const entries=Object.entries(values),historyId='YAHOO_PAYMENT:'+candidate.id;
  await db.send(new TransactWriteCommand({TransactItems:[
   {Update:{TableName:table('Inventory'),Key:{id:item.id},UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(','),ConditionExpression:'updatedAt=:version AND quantity=:quantity AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)',ExpressionAttributeNames:Object.fromEntries(entries.map(([k],i)=>['#f'+i,k])),ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v])),':version':item.updatedAt,':quantity':queue.soldQuantity}}},
   ...persistence.categoryLinkChanges(item.id,before,after,now),
   {Put:{TableName:table('InventoryHistory'),Item:{id:historyId,inventoryId:item.id,fieldName:'ヤフオク入金確認',oldValue:JSON.stringify({categoryIds:before,saleEndDate:null}),newValue:JSON.stringify({categoryIds:after,saleEndDate:changes.saleEndDate,candidateId:candidate.id,auctionId:queue.auctionId,mailReceivedAt:payment.paidAt}),changedBy:'ヤフオク入金確認',changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}},
   {Update:{TableName:candidateTable,Key:{id:candidate.id},UpdateExpression:'SET yahooPaymentState=:applied,yahooPaymentAppliedAt=:now,updatedAt=:now REMOVE yahooPaymentError',ConditionExpression:'#s=:done AND updatedAt=:version AND yahooPaymentState=:waiting',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':applied':'APPLIED',':now':now,':done':'DONE',':version':candidate.updatedAt,':waiting':'WAITING'}}},
   {Delete:{TableName:candidateTable,Key:{id:queue.id},ConditionExpression:'soldId=:sold AND candidateId=:candidate',ExpressionAttributeValues:{':sold':item.id,':candidate':candidate.id}}}
  ]}));
  return 'applied';
 }
 async function run(){
  const statusId='YAHOO_PAYMENT_CURSOR',status=await get(statusId),started=Date.now();
  let cursor=status?.cursor,checked=0,applied=0,errors=0;
  do{
   const page=await db.send(new QueryCommand({TableName:candidateTable,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':YAHOO_PAYMENT_QUEUE_STATE},Limit:25,ExclusiveStartKey:cursor}));
   for(const queue of (page.Items||[]) as Queue[]){
    checked++;
    try{if(await settle(queue)==='applied')applied++;}
    catch(e){
     // Lost responses/concurrent invocations are harmless: the durable state is read again on the next pass.
     errors++;const code=(e as Error).message==='PAYMENT_INVENTORY_CONFLICT'?'商品が変更されています。入金待ちの商品情報を確認してください。':'入金後の更新を再試行します。';
     await db.send(new UpdateCommand({TableName:candidateTable,Key:{id:queue.candidateId},UpdateExpression:'SET yahooPaymentError=:error',ConditionExpression:'#s=:done AND yahooPaymentState=:waiting',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':error':code,':done':'DONE',':waiting':'WAITING'}})).catch(()=>{});
    }
   }
   cursor=page.LastEvaluatedKey;
  }while(cursor&&Date.now()-started<45000);
  await db.send(new PutCommand({TableName:candidateTable,Item:{id:statusId,cursor:cursor??null,checked,applied,errors,lastRunAt:new Date().toISOString()}}));
  return {checked,applied,errors,more:!!cursor};
 }
 return {settle,run};
}
