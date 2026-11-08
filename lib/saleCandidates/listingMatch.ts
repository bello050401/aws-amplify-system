import 'server-only';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {readEconveniCatalog} from '../listing/econveni/runtimeStore';
import {readManualSync} from '../listing/econveni/manualSync';
import {collectYahooInventoryIds} from './yahooListingMatch';
/** Never select by a shared barcode/title when an immutable channel item ID is available. */
export async function exactBaseInventoryIds(externalListingId:string){
 return exactListingInventoryIds('BASE',externalListingId);
}
export async function exactListingInventoryIds(channel:'BASE'|'YAHOO',externalListingId:string){
 if(!(channel==='BASE'?/^[1-9][0-9]*$/:/^[a-z][0-9]{6,15}$/).test(externalListingId))return [];
 if(channel==='YAHOO'){
  const legacy:{inventoryId?:string;auctionId?:string;deletedAt?:string|null}[]=[];let cursor:Record<string,unknown>|undefined,pages=0;
  do{
   const r=await inventoryDdb.send(new ScanCommand({TableName:inventoryTable('YahooAuctionListing'),ExclusiveStartKey:cursor,FilterExpression:'auctionId=:id',ExpressionAttributeValues:{':id':externalListingId},ProjectionExpression:'inventoryId,auctionId,deletedAt',ConsistentRead:true}));
   legacy.push(...r.Items??[]);cursor=r.LastEvaluatedKey;if(++pages>30)throw Error('LISTING_MATCH_LIMIT');
  }while(cursor);
  const [workflows,manual]=await Promise.all([readEconveniCatalog(),readManualSync()]);
  return collectYahooInventoryIds(externalListingId,legacy,workflows,manual);
 }
 const ids=new Set<string>();let key:Record<string,unknown>|undefined,pages=0;
 do{
  const r=await inventoryDdb.send(new ScanCommand({TableName:inventoryTable('ChannelListing'),ExclusiveStartKey:key,FilterExpression:'channel=:channel AND externalListingId=:id',ExpressionAttributeValues:{':channel':channel,':id':externalListingId},ProjectionExpression:'inventoryId,deletedAt'}));
  for(const row of r.Items??[])if(!row.deletedAt&&typeof row.inventoryId==='string')ids.add(row.inventoryId);
  key=r.LastEvaluatedKey;if(++pages>30)throw Error('LISTING_MATCH_LIMIT');
 }while(key);
 // Legacy/manual e-conveni links carry the same immutable BASE item ID.
 // Keep all matches: stock splits must be reviewed, never choose the first one.
 const manual=await readManualSync();
 for(const link of manual.links){
  if(link.disabled)continue;
  const remote=manual.snapshot?.products.find(p=>p.productId===link.productId);
  const observed=remote?.channels.BASE?.listingId, baseline=link.baseline.BASE?.listingId;
  // A stale baseline cannot identify an order after the remote listing ID changed.
  if(observed===externalListingId&&(!baseline||baseline===observed))ids.add(link.inventoryId);
 }
 return [...ids];
}
