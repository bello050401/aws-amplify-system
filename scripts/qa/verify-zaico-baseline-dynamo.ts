/** Disposable QA records only. No ZAICO API calls and no production table access. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DynamoDBClient,DescribeTableCommand,ListTagsOfResourceCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,DeleteCommand,GetCommand} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {syncOneZaicoItem} from '../../lib/inventory/zaicoSyncEngine';
import type {InventoryModel,ZaicoSyncPort} from '../../lib/inventory/zaicoSyncPorts';
import type {ZaicoInventory} from '../../lib/zaico/client';

async function main(){
 const dir=process.argv[2];if(!dir)throw Error('Evidence directory required');
 fs.mkdirSync(dir,{recursive:true});
 const suffix='-duwktv6y2jcm3idujer76hkmou-NONE';
 const table=(model:string)=>model+suffix;
 assert.notEqual(suffix,'-j6up24p7lnczdmklzjdt3vrp4y-NONE');
 const lowLevel=new DynamoDBClient({region:'us-west-2'});
 const described=await lowLevel.send(new DescribeTableCommand({TableName:table('Inventory')}));
 const tags=await lowLevel.send(new ListTagsOfResourceCommand({ResourceArn:described.Table!.TableArn!}));
 assert.ok(tags.Tags?.some(tag=>tag.Key==='amplify:deployment-type'&&tag.Value==='sandbox'),'Only sandbox tables may be used');
 const db=DynamoDBDocumentClient.from(lowLevel,{marshallOptions:{removeUndefinedValues:true}});
 const persistence=createInventoryPersistence(db,table);
 const id=randomUUID(),categoryId=randomUUID(),statusId=randomUUID(),now=new Date().toISOString();
 const results:{case:string;passed:boolean}[]=[];
 const masters=[{model:'Category',row:{id:categoryId,name:`ZAICO初回同期検証-${id}`,sortOrder:0,isActive:true,createdAt:now,updatedAt:now}},
   {model:'StatusMaster',row:{id:statusId,label:'検証用状態',code:`QA_${id}`,sortOrder:0,isActive:true,createdAt:now,updatedAt:now}}];
 const before=async()=>await persistence.getInventoryRaw(id) as InventoryModel;
 let backupIndex=0;
 const archive:NonNullable<ZaicoSyncPort['archiveBeforeInitialSync']>=async(inventory,zaico)=>{
   const content=JSON.stringify({inventory,zaico});
   const file=path.join(dir,`backup-${id}-${++backupIndex}.json`);
   fs.writeFileSync(file,content,{flag:'wx'});
   assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),createHash('sha256').update(content).digest('hex'));
 };
 const unexpected=async():Promise<never>=>{throw Error('This QA case must not create source links or import images');};
 const port:ZaicoSyncPort={
   findExistingBySourceId:before,
   archiveBeforeInitialSync:archive,
   findOrCreateStatus:async()=>({id:statusId,created:false}),
   findOrCreateCategory:async()=>({id:categoryId,created:false}),
   updateInventory:async(input)=>{
     const {expectedUpdatedAt,extendedFields,...fields}=input;
     await persistence.persistInventoryWithCategories({...fields,...extendedFields},expectedUpdatedAt,{preserveZaicoSourceBarcode:true});
   },
   logHistory:async()=>{},
   fetchAllZaicoManaged:unexpected,
   findOrCreateLocation:unexpected,
   generateSku:unexpected,
   createInventory:unexpected,
   downloadAndImportImage:unexpected,
   removeImage:unexpected,
   claimSourceLink:unexpected,
   releaseSourceLink:unexpected,
 };
 const item:ZaicoInventory={id:999999999,title:'QA ZAICO初回同期の正本',quantity:null,unit:'',category:'',state:'検証用状態',
   place:'',etc:'',code:`QA-${id}`,item_image:null,optional_attributes:[]};
 let created=false;
 const createdMasters:typeof masters=[];
 try {
   for(const master of masters){
     await db.send(new PutCommand({TableName:table(master.model),Item:master.row,ConditionExpression:'attribute_not_exists(id)'}));
     createdMasters.push(master);
   }
   await persistence.persistInventoryWithCategories({
     id,sku:`QA-${id}`,name:'初回前のBELLO値',quantity:9,categoryIds:[categoryId],categoryId,
     unit:'点',note:'元の備考',salePrice:1234,plannedSalePrice:4321,statusId,
     images:[],customFields:JSON.stringify({belloOnly:'独自項目は残す'}),
     sourceSystem:'ZAICO',sourceInventoryId:'999999999',
     createdBy:'ZAICO transition QA',updatedBy:'ZAICO transition QA',
   });
   created=true;
   const failedBackup=await syncOneZaicoItem(item,'QA',undefined,{...port,archiveBeforeInitialSync:async()=>{throw Error('controlled backup failure')}},undefined,'ZAICO_BASELINE');
   assert.equal(failedBackup.status,'failed');assert.equal((await before()).quantity,9);
   results.push({case:'バックアップ失敗時にDynamoDBの値を変更しない',passed:true});
   const synced=await syncOneZaicoItem(item,'QA',undefined,port,undefined,'ZAICO_BASELINE');
   assert.equal(synced.status,'updated',synced.error);
   const readback=await before();
   assert.equal(readback.name,item.title);
   // The persistence layer removes null attributes; AppSync presents them as null.
   for(const key of ['quantity','note','salePrice','plannedSalePrice'])
     assert.equal(Object.prototype.hasOwnProperty.call(readback,key),false,`${key} must be cleared`);
   assert.equal(readback.statusId,statusId);assert.deepEqual(readback.categoryIds,[]);
   assert.equal(JSON.parse(String(readback.customFields)).belloOnly,'独自項目は残す');
   assert.equal(JSON.parse(String(readback.zaicoSnapshotJson)).quantity,null);
   results.push({case:'ZAICO優先・未入力値・状態・独自項目を保存後の強整合読み込みで確認',passed:true});
   const categoryLink=await db.send(new GetCommand({TableName:table('InventoryCategory'),Key:{id:persistence.categoryLinkId(id,categoryId)},ConsistentRead:true}));
   assert.equal(categoryLink.Item,undefined);
   const concurrentPort={...port,archiveBeforeInitialSync:async(inventory:InventoryModel,zaico:ZaicoInventory)=>{
     await archive(inventory,zaico);
     await persistence.persistInventoryWithCategories({id,quantity:55,updatedBy:'別端末の編集'},inventory.updatedAt);
   }};
   const concurrent=await syncOneZaicoItem({...item,quantity:2},'QA',undefined,concurrentPort,undefined,'ZAICO_BASELINE');
   assert.equal(concurrent.status,'failed');
   assert.equal((await before()).quantity,55);
   results.push({case:'バックアップ後に別端末が編集した場合は上書きを拒否',passed:true});
   const invalid=await syncOneZaicoItem({...item,optional_attributes:[{name:'⚫︎数量',value:'数点'}]},'QA',undefined,port,undefined,'ZAICO_BASELINE');
   assert.equal(invalid.status,'failed');assert.equal((await before()).quantity,55);
   results.push({case:'意味を確定できない元データは既存値を壊さず失敗として返す',passed:true});
 } finally {
   if(created&&await before())await persistence.deleteInventoryWithCategories(id,(await before()).updatedAt,'ZAICO transition QA cleanup');
   for(const master of createdMasters)await db.send(new DeleteCommand({TableName:table(master.model),Key:{id:master.row.id}}));
   const remaining=created?await before():null;
   fs.writeFileSync(path.join(dir,'qa-result.json'),JSON.stringify({at:new Date().toISOString(),environment:'QA',fixtureId:id,results,
     fixtureRemoved:!remaining,productionWrites:0,zaicoApiCalls:0,zaicoWrites:0},null,2));
   assert.ok(!remaining);
 }
 console.log(JSON.stringify({passed:results.length,fixtureRemoved:true,productionWrites:0,zaicoApiCalls:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
