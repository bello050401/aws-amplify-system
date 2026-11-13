import {BatchGetCommand,PutCommand,QueryCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable} from '../../../lib/inventory/categoryPersistence';
import {refreshManualSync,readManualSync} from '../../../lib/listing/econveni/manualSync';
import {readEconveniCatalog} from '../../../lib/listing/econveni/runtimeStore';
import {inventoryCategoryIds} from '../../../lib/inventory/categories';
import {shouldRetireCandidate,type ListingObservation} from '../../../lib/saleCandidates/maintenancePolicy';
import type {SaleCandidate} from '../../../lib/saleCandidates/model';

async function scan(name:string,projection:string){let cursor:Record<string,unknown>|undefined;const rows:Record<string,any>[]=[];const names=Object.fromEntries(projection.split(',').map((n,i)=>['#f'+i,n]));do{const r=await db.send(new ScanCommand({TableName:inventoryTable(name),ProjectionExpression:Object.keys(names).join(','),ExpressionAttributeNames:names,ExclusiveStartKey:cursor}));rows.push(...r.Items??[]);cursor=r.LastEvaluatedKey;if(rows.length>30000)throw Error('MAINTENANCE_SCAN_LIMIT');}while(cursor);return rows;}
export async function runCatalogMaintenance(){
 const table=process.env.SALE_CANDIDATES_TABLE!,at=new Date().toISOString();
 const result={startedAt:at,checked:0,retired:0,unmatched:0,conflicts:0,econveni:'PENDING',error:''};
 // Pull observations only. Never publish, delete a sold page, or reinterpret an
 // unknown remote state as zero stock. Existing catalog overlays use this snapshot.
 try{await refreshManualSync();result.econveni='SYNCED';}catch(e){result.econveni='FAILED';result.error=(e as Error).name||'ECONVENI_REFRESH_FAILED';}
 try{
  const [manual,workflows,listings,yahoo,categories]=await Promise.all([readManualSync(),readEconveniCatalog(),scan('ChannelListing','inventoryId,channel,externalListingId,deletedAt'),scan('YahooAuctionListing','inventoryId,auctionId,deletedAt'),scan('Category','id,#name'.replace('#name','name'))]);
  const selling=new Set(categories.filter(c=>['販売中','出品中','複数在庫未出品'].includes(String(c.name??'').replace(/\s/g,''))).map(c=>c.id));
  if(!selling.size)throw Error('SELLING_CATEGORIES_UNAVAILABLE');
  const matches=new Map<string,Set<string>>();const add=(channel:string,id:unknown,inventoryId:unknown)=>{if(typeof id!=='string'||!id||typeof inventoryId!=='string')return;const key=channel+':'+id;const set=matches.get(key)??new Set();set.add(inventoryId);matches.set(key,set);};
  for(const row of listings)if(!row.deletedAt)add(row.channel==='MERCARI_SHOPS'?'MERCARI':row.channel,row.externalListingId,row.inventoryId);
  for(const row of yahoo)if(!row.deletedAt)add('YAHOO',row.auctionId,row.inventoryId);
  for(const link of manual.links){const remote=manual.snapshot?.products.find(p=>p.productId===link.productId);for(const channel of ['BASE','YAHOO','MERCARI_SHOPS'] as const){const state=remote?.channels[channel]??link.baseline[channel];add(channel==='MERCARI_SHOPS'?'MERCARI':channel,state.listingId,link.inventoryId);}}
  for(const w of workflows)for(const channel of ['YAHOO','MERCARI_SHOPS'] as const)add(channel==='MERCARI_SHOPS'?'MERCARI':channel,w.channels[channel]?.listingId,w.inventoryId);
  let cursor:Record<string,unknown>|undefined,pages=0;
  do{
   const page=await db.send(new QueryCommand({TableName:table,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'PENDING'},Limit:100,ExclusiveStartKey:cursor}));
   const targets=(page.Items??[]).flatMap(c=>{const ids=matches.get(c.channel+':'+(c.externalListingId||(c.channel==='YAHOO'?c.orderId:'')));if(!ids||ids.size!==1){result.unmatched++;return [];}return[{candidate:c as SaleCandidate&{listingObservation?:ListingObservation},id:[...ids][0]}];});
   const ids=[...new Set(targets.map(t=>t.id))],inventory=new Map<string,Record<string,any>>();
   for(let i=0;i<ids.length;i+=100){const r=await db.send(new BatchGetCommand({RequestItems:{[inventoryTable('Inventory')]:{Keys:ids.slice(i,i+100).map(id=>({id})),ConsistentRead:true,ProjectionExpression:'id,categoryIds,categoryId,updatedAt,deletedAt,isDeleted'}}}));if(Object.keys(r.UnprocessedKeys??{}).length)throw Error('INVENTORY_READ_INCOMPLETE');for(const row of r.Responses?.[inventoryTable('Inventory')]??[])inventory.set(row.id,row);}
   for(const {candidate:c,id} of targets){
    const row=inventory.get(id);if(!row||row.deletedAt||row.isDeleted||!row.updatedAt){result.unmatched++;continue;}
    const observation:ListingObservation={inventoryId:id,selling:inventoryCategoryIds(row).some(id=>selling.has(id)),at,inventoryVersion:row.updatedAt};
    const retire=shouldRetireCandidate(c,c.listingObservation,observation);
    try{await db.send(new TransactWriteCommand({TransactItems:[
     {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt=:version AND attribute_not_exists(deletedAt) AND (attribute_not_exists(isDeleted) OR isDeleted=:false)',ExpressionAttributeValues:{':version':row.updatedAt,':false':false}}},
     {Update:{TableName:table,Key:{id:c.id},ConditionExpression:'#s=:pending AND updatedAt=:version AND (attribute_not_exists(listingObservation.#at) OR listingObservation.#at<:observedAt)',UpdateExpression:'SET listingObservation=:observation'+(retire?', #s=:archived, archivedAt=:at, archiveReason=:reason, updatedAt=:at':''),ExpressionAttributeNames:{'#s':'state','#at':'at'},ExpressionAttributeValues:{':pending':'PENDING',':version':c.updatedAt,':observation':observation,':observedAt':at,...(retire?{':archived':'ARCHIVED',':at':at,':reason':'LINKED_INVENTORY_LEFT_SELLING'}:{})}}}
    ]}));result.checked++;if(retire)result.retired++;}catch(e){if((e as Error).name!=='TransactionCanceledException')throw e;result.conflicts++;}
   }
   cursor=page.LastEvaluatedKey;if(++pages>100)throw Error('CANDIDATE_MAINTENANCE_LIMIT');
  }while(cursor);
 }catch(e){result.error=(e as Error).name+':'+((e as Error).message.match(/^[A-Z_]+$/)?.[0]||'CANDIDATE_CHECK_FAILED');}
 await db.send(new PutCommand({TableName:table,Item:{id:'CATALOG_MAINTENANCE_STATUS',...result,finishedAt:new Date().toISOString()}}));
 if(result.error)console.warn('CATALOG_MAINTENANCE_INCOMPLETE',result);return result;
}
