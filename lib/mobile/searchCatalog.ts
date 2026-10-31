import 'server-only';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {directTableName} from '@/lib/amplify/directData';
import {buildCountExpression} from '@/lib/inventory/inventoryCountFast';
import {resolveDisplayInventoryId} from '@/lib/inventory/inventoryId';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import type {InventoryItem} from '@/mobile/src/domain/inventory';
import {readCompactSearch} from '@/lib/inventory/readCompactSearch';

const client=DynamoDBDocumentClient.from(new DynamoDBClient({region:process.env.AWS_REGION||'us-west-2'}));
type CatalogRecord={id:string;sku?:string;sourceSystem?:string;sourceInventoryId?:string;name?:string;quantity?:number;unit?:string;categoryId?:string;categoryIds?:string[];locationId?:string;statusId?:string;barcode?:string;plannedSalePrice?:number;createdAt?:string;updatedAt:string;listUpdatedAt?:string};
// Minimal search projection, never originals, custom fields or sales/customer records.
export const CATALOG_ATTRIBUTES=['id','sku','sourceSystem','sourceInventoryId','name','quantity','unit','categoryId','categoryIds','locationId','statusId','barcode','plannedSalePrice','createdAt','updatedAt','listUpdatedAt'] as const;
export async function readSearchCatalog(masters:{categories:{id:string;name:string}[];locations:{id:string;name:string}[];statuses:{id:string;label:string}[]},fresh=false):Promise<InventoryItem[]>{
 const names=Object.fromEntries(CATALOG_ATTRIBUTES.map((key,i)=>['#p'+i,key]));
 const filter=buildCountExpression({});
 const indexed=fresh?null:await readCompactSearch(client,{TableName:directTableName('Inventory'),
  ProjectionExpression:Object.keys(names).join(','),ExpressionAttributeNames:{...names,...filter.names},
  FilterExpression:filter.filterExpression,ExpressionAttributeValues:filter.values},[...CATALOG_ATTRIBUTES,'deletedAt','listingPartition']);
 const segments=indexed?[indexed as CatalogRecord[]]:await Promise.all(Array.from({length:8},async(_,segment)=>{
  const rows:CatalogRecord[]=[];let key:Record<string,unknown>|undefined;let pages=0;
  do{
   const page=await client.send(new ScanCommand({TableName:directTableName('Inventory'),Segment:segment,TotalSegments:8,
    ProjectionExpression:Object.keys(names).join(','),ExpressionAttributeNames:{...names,...filter.names},FilterExpression:filter.filterExpression,ExpressionAttributeValues:filter.values,ExclusiveStartKey:key}));
   rows.push(...(page.Items??[]) as CatalogRecord[]);key=page.LastEvaluatedKey;
   if(++pages>60||rows.length>20000)throw Error('CATALOG_LIMIT');
  }while(key);return rows;
 }));
 const rows=segments.flat();if(rows.length>20000)throw Error('CATALOG_LIMIT');
 const cats=new Map(masters.categories.map(r=>[r.id,r.name])),locs=new Map(masters.locations.map(r=>[r.id,r.name])),states=new Map(masters.statuses.map(r=>[r.id,r.label]));
 return rows.map(row=>({id:row.id,sku:row.sku??'',displayId:resolveDisplayInventoryId({sourceSystem:row.sourceSystem??null,sourceInventoryId:row.sourceInventoryId??null,sku:row.sku??''}),name:row.name??'',quantity:row.quantity??0,quantityUnset:row.quantity==null,
  unit:row.unit??'',category:inventoryCategoryIds(row).map(id=>cats.get(id)).filter(Boolean).join(','),location:locs.get(row.locationId??'')??'',statusId:row.statusId??null,condition:states.get(row.statusId??'')??'',
  barcode:row.barcode??'',note:'',plannedSalePrice:row.plannedSalePrice??null,thumbnailUrl:null,createdAt:row.createdAt,updatedAt:row.updatedAt,listUpdatedAt:row.listUpdatedAt??undefined}));
}

// Coalesce concurrent reads within one server instance. Every caller authorizes first.
// Forced refresh after a local edit bypasses cached and in-flight older reads.
let cached:{key:string;items:InventoryItem[];checkedAt:string}|null=null;
let pending:{key:string;promise:Promise<{items:InventoryItem[];checkedAt:string}>}|null=null;
export async function cachedSearchCatalog(masters:Parameters<typeof readSearchCatalog>[0],fresh=false){
 const key=JSON.stringify(masters);
 if(!fresh&&cached?.key===key&&Date.now()-Date.parse(cached.checkedAt)<15000)return cached;
 if(!fresh&&pending?.key===key)return pending.promise;
 const checkedAt=new Date().toISOString();
 const promise=readSearchCatalog(masters,fresh).then(items=>{
  if(!cached||cached.checkedAt<=checkedAt)cached={key,items,checkedAt};
  return {items,checkedAt};
 });
 pending={key,promise};
 try{return await promise;}finally{if(pending?.promise===promise)pending=null;}
}
