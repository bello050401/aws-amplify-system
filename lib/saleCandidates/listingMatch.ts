import 'server-only';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
/** Never select by a shared barcode/title when an immutable channel item ID is available. */
export async function exactBaseInventoryIds(externalListingId:string){
 if(!/^[1-9][0-9]*$/.test(externalListingId))return [];
 const ids=new Set<string>();let key:Record<string,unknown>|undefined,pages=0;
 do{
  const r=await inventoryDdb.send(new ScanCommand({TableName:inventoryTable('ChannelListing'),ExclusiveStartKey:key,FilterExpression:'channel=:channel AND externalListingId=:id',ExpressionAttributeValues:{':channel':'BASE',':id':externalListingId},ProjectionExpression:'inventoryId,deletedAt'}));
  for(const row of r.Items??[])if(!row.deletedAt&&typeof row.inventoryId==='string')ids.add(row.inventoryId);
  key=r.LastEvaluatedKey;if(++pages>30)throw Error('LISTING_MATCH_LIMIT');
 }while(key);
 return [...ids];
}
