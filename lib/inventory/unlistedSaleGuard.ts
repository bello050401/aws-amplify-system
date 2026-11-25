import 'server-only';
import {GetCommand,ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {InventoryTransaction} from './categoryPersistenceCore';
import {SoldOutError} from './soldOutInput';
import {inventoryDdb,inventoryTable} from './categoryPersistence';
import {ECONVENI_WORKFLOW_TABLE} from '../listing/econveni/runtimeStore';

const blocked=()=>new SoldOutError('INVALID','出品・紐付けまたは未確認のEC処理があります。eコンビニに出品しない登録はできません。EC出品画面で確認してください。');
type Operation={state?:string;productId?:string;operationId?:string;listingId?:string;remoteStatus?:string};
type Row={id:string;inventoryId?:string;revision?:number;updatedAt?:string;status:string;externalListingId?:string;listingUrl?:string;firstListedAt?:string;lastListedAt?:string;lastRelistedAt?:string;endedAt?:string;soldAt?:string;save?:Operation;channels?:Record<string,Operation>};
/** Read local durable evidence only. Never logs in to or writes to an external EC. */
export function createUnlistedSaleGuard(db:DynamoDBDocumentClient,table:(name:string)=>string,workflowTable:string){
 return async (inventoryId:string):Promise<InventoryTransaction>=>{
  const checks:InventoryTransaction=[];
  for(const prefix of ['ECONVENI#INVENTORY#','ECONVENI#MANUAL_LINK#']){
   const key={pk:prefix+inventoryId};
   const row=(await db.send(new GetCommand({TableName:workflowTable,Key:key,ConsistentRead:true}))).Item as Row|undefined;
   // Even an unlinked historic product can still be selling remotely. This mode
   // is reserved for never-linked inventory; it cannot acknowledge remote stops.
   if(row){
    const untouched=prefix==='ECONVENI#INVENTORY#'&&row.save?.state==='NOT_STARTED'&&!row.save?.productId&&!row.save?.operationId&&['YAHOO','MERCARI_SHOPS'].every(c=>row.channels?.[c]?.state==='NOT_STARTED'&&!row.channels[c].listingId&&!row.channels[c].operationId&&!row.channels[c].remoteStatus)&&Number.isSafeInteger(row.revision);
    if(!untouched)throw blocked();
    checks.push({ConditionCheck:{TableName:workflowTable,Key:key,ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':row.revision}}});
   }else checks.push({ConditionCheck:{TableName:workflowTable,Key:key,ConditionExpression:'attribute_not_exists(pk)'}});
  }
  const nativeKeys=new Set<string>(['ec-base-'+inventoryId]);
  let cursor:Record<string,unknown>|undefined;
  let scanned=0;
  do{
   const result=await db.send(new ScanCommand({TableName:table('ChannelListing'),ConsistentRead:true,FilterExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':inventoryId},ProjectionExpression:'id',Limit:1000,ExclusiveStartKey:cursor}));
   scanned+=result.ScannedCount??result.Items?.length??0;
   for(const indexed of result.Items??[])nativeKeys.add(indexed.id);
   cursor=result.LastEvaluatedKey;
   if(nativeKeys.size>50||scanned>20000)throw new SoldOutError('UNCONFIRMED','出品状況の確認が完了しませんでした。時間をおいて再度確認してください。');
  }while(cursor);
  for(const id of nativeKeys){
    // Re-read every known row consistently and bind
    // its version to the sale transaction before allowing an untouched draft.
    const row=(await db.send(new GetCommand({TableName:table('ChannelListing'),Key:{id},ConsistentRead:true}))).Item as Row|undefined;
    if(!row){checks.push({ConditionCheck:{TableName:table('ChannelListing'),Key:{id},ConditionExpression:'attribute_not_exists(id)'}});continue;}
    if(row.inventoryId!==inventoryId||!['NOT_PREPARED','DRAFT','READY'].includes(row.status)||row.externalListingId||row.listingUrl||row.firstListedAt||row.lastListedAt||row.lastRelistedAt||row.endedAt||row.soldAt||!row.updatedAt)throw blocked();
    checks.push({ConditionCheck:{TableName:table('ChannelListing'),Key:{id:row.id},ConditionExpression:'updatedAt=:v AND #s=:s',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':v':row.updatedAt,':s':row.status}}});
  }
  return checks;
 };
}
export const verifyUnlistedSale=createUnlistedSaleGuard(inventoryDdb,inventoryTable,ECONVENI_WORKFLOW_TABLE);
