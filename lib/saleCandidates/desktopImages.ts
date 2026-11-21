import 'server-only';
import {inventoryDdb,inventoryTable} from '../inventory/categoryPersistence';
import {DynamoPhotoRegistrationRepository} from '../photoRegistration/awsRepository';
import {photoAssetS3Key,extensionForMimeType} from '../photoRegistration/types';

/** Exact authorized inventory/photo-service references, never client-supplied buckets or URLs. */
export async function desktopImageKeys(item:Record<string,unknown>):Promise<string[]> {
 let parsed=item.images;
 if(typeof parsed==='string'){try{parsed=JSON.parse(parsed);}catch{throw Error('DESKTOP_IMAGES_INVALID');}}
 const images=Array.isArray(parsed)?parsed:[];
 const keys=images.filter(i=>i&&typeof i==='object'&&i.type!=='DAMAGE').map(i=>i.storageKey).filter((k):k is string=>typeof k==='string'&&k.startsWith('inventory/')&&!k.includes('..'));
 const main=item.mainImageStorageKey;if(typeof main==='string'&&main.startsWith('inventory/')&&!main.includes('..'))keys.unshift(main);
 const table=process.env.PHOTO_REGISTRATION_TABLE_NAME;
 if(table){
  if(!process.env.PHOTO_REGISTRATION_BUCKET_NAME)throw Error('DESKTOP_PHOTO_CONFIG_REQUIRED');
  const repo=new DynamoPhotoRegistrationRepository({ddb:inventoryDdb,tableName:table,inventoryTableName:process.env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME||inventoryTable('Inventory'),now:()=>new Date()});
  let cursor:string|null=null;let batchCount=0;
  do{
   const page=await repo.listBatchesForInventory(String(item.id),100,cursor);batchCount+=page.items.length;
   if(batchCount>300)throw Error('DESKTOP_PHOTO_LIMIT');
   for(const batch of page.items){
    if(batch.inventoryId!==item.id)throw Error('DESKTOP_PHOTO_OWNER_CHANGED');
    const canonical=await repo.getBatchById(batch.id);
    if(!canonical||canonical.inventoryId!==item.id||canonical.status!=='LINKED')throw Error('DESKTOP_PHOTO_OWNER_CHANGED');
    const assets=await repo.getAssetsForBatch(batch.id);
    for(const a of assets.filter(a=>a.status==='READY'&&!a.isDeleted&&!a.purgedAt&&!a.purgeStartedAt&&a.inventoryImageType!=='DAMAGE'))keys.push(photoAssetS3Key(a.photoBatchId,a.id,'PROCESSED',extensionForMimeType(a.declared.PROCESSED.mimeType)));
   }
   cursor=page.nextCursor;
  }while(cursor);
 }
 return [...new Set(keys)].sort().slice(0,20);
}
