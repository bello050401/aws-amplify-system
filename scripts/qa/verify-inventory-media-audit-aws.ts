import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,DeleteObjectCommand,HeadObjectCommand,ListObjectVersionsCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-providers';
import {writeFileSync} from 'node:fs';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {InventoryMutationRejected,InventorySaveError} from '../../lib/inventory/conditionalUpdate';
import {deleteAllPhotoObjectVersions} from '../../lib/mediaMaintenance/deletePhotoObject';
async function main(){
 if(process.env.BELLO_AUDIT_SCRATCH!=='1')throw Error('Scratch opt-in required');
 const cfg={region:'us-west-2',credentials:fromIni({profile:'Bello'}),maxAttempts:2},raw=new DynamoDBClient(cfg),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}}),s3=new S3Client(cfg);
 const prefix='Bello-QA-InventoryAudit-'+randomUUID().slice(0,8)+'-',created:string[]=[],keys:string[]=[],passed:string[]=[];
 const table=(m:string)=>prefix+m,bucket='bello-photo-e2e-validation-photobucket-l3bwsehg6e26',photoPrefix='photo-batches/'+randomUUID()+'/audit/';
 const report:{startedAt:string;passed:string[];cleanup?:string}={startedAt:new Date().toISOString(),passed};
 const read=async(m:string,id:string)=>(await db.send(new GetCommand({TableName:table(m),Key:{id},ConsistentRead:true}))).Item;
 const save=()=>writeFileSync('artifacts/system-audit-20261101/inventory-media-aws.json',JSON.stringify(report,null,2));
 const check=(s:string)=>{passed.push(s);save();console.log('PASS',s);};
 try{
  for(const m of ['Inventory','Category','InventoryCategory','InventoryHistory']){const TableName=table(m);await raw.send(new CreateTableCommand({TableName,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],Tags:[{Key:'Purpose',Value:'disposable-audit'}]}));created.push(TableName);}
  await Promise.all(created.map(TableName=>waitUntilTableExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  for(const id of ['repair','move'])await db.send(new PutCommand({TableName:table('Category'),Item:{id,name:id}}));
  const p=createInventoryPersistence(db,table),createdStock=await p.persistInventoryWithCategories({id:'original',quantity:5,name:'QA item',barcode:'2026042311254',categoryIds:['repair','move'],locationId:'office'});
  assert.equal((await read('Inventory','original'))?.quantity,5);assert.ok(await read('InventoryCategory','original:repair'));assert.ok(await read('InventoryCategory','original:move'));check('create persists quantity, timestamps and both category links');
  const updated=await p.persistInventoryWithCategories({id:'original',name:'QA renamed',categoryIds:['repair'],quantity:4},createdStock.updatedAt);assert.equal(await read('InventoryCategory','original:move'),undefined);assert.equal((await read('Inventory','original'))?.name,'QA renamed');check('edit removes obsolete category link and advances revision');
  await assert.rejects(p.persistInventoryWithCategories({id:'original',quantity:9},createdStock.updatedAt),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');assert.equal((await read('Inventory','original'))?.quantity,4);check('stale edit cannot overwrite newer quantity');
  await p.persistInventoryWithCategories({id:'duplicate',quantity:2,name:'QA copy',barcode:'2026042311254',categoryIds:['repair']});assert.equal((await read('Inventory','duplicate'))?.barcode,(await read('Inventory','original'))?.barcode);check('duplicate barcode allowed without merging independent stock');
  await db.send(new UpdateCommand({TableName:table('Inventory'),Key:{id:'original'},UpdateExpression:'SET outboundArrivalBatchId=:id',ExpressionAttributeValues:{':id':'qa-batch'}}));
  for(const change of [{quantity:1},{locationId:'warehouse'},{categoryIds:['move']}])await assert.rejects(p.persistInventoryWithCategories({id:'original',...change},updated.updatedAt),e=>e instanceof InventoryMutationRejected&&e.code==='ARRIVAL_RESERVED');
  await assert.rejects(p.deleteInventoryWithCategories('original',updated.updatedAt),e=>e instanceof InventoryMutationRejected&&e.code==='ARRIVAL_RESERVED');
  const named=await p.persistInventoryWithCategories({id:'original',name:'QA allowed name',plannedSalePrice:4000},updated.updatedAt);assert.equal((await read('Inventory','original'))?.quantity,4);check('arrival reservation protects quantity/location/categories/delete; name and price remain editable');
  await db.send(new UpdateCommand({TableName:table('Inventory'),Key:{id:'original'},UpdateExpression:'REMOVE outboundArrivalBatchId'}));
  let raced=false;
  const racing={send:async(command:any)=>{if(command instanceof TransactWriteCommand&&!raced){raced=true;await db.send(new UpdateCommand({TableName:table('Inventory'),Key:{id:'original'},UpdateExpression:'SET outboundArrivalBatchId=:b',ExpressionAttributeValues:{':b':'concurrent-batch'}}));}return db.send(command);}} as unknown as typeof db;
  await assert.rejects(createInventoryPersistence(racing,table).deleteInventoryWithCategories('original',named.updatedAt),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');assert.ok(await read('Inventory','original'));assert.ok(await read('InventoryCategory','original:repair'));check('reservation created between read and delete is rejected atomically');
  await db.send(new UpdateCommand({TableName:table('Inventory'),Key:{id:'original'},UpdateExpression:'REMOVE outboundArrivalBatchId'}));
  await p.deleteInventoryWithCategories('original',named.updatedAt,'qa');assert.equal(await read('Inventory','original'),undefined);assert.equal(await read('InventoryCategory','original:repair'),undefined);assert.equal((await read('Inventory','duplicate'))?.quantity,2);
  const histories=(await db.send(new ScanCommand({TableName:table('InventoryHistory'),ConsistentRead:true}))).Items!;assert.equal(histories.length,1);assert.equal(histories[0].newValue,'削除済み');check('delete physically removes item/category links, preserves independent copy and one audit receipt');
  const target=photoPrefix+'target.bin',neighbor=target+'.keep',control=photoPrefix+'control.bin';keys.push(target,neighbor,control);
  for(let i=0;i<3;i++)await s3.send(new PutObjectCommand({Bucket:bucket,Key:target,Body:Buffer.from('synthetic audit '+i)}));
  await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:target}));
  for(const Key of [neighbor,control])await s3.send(new PutObjectCommand({Bucket:bucket,Key,Body:Buffer.from('unrelated control')}));
  const before=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:target}));assert.equal(before.Versions?.filter(x=>x.Key===target).length,3);assert.equal(before.DeleteMarkers?.filter(x=>x.Key===target).length,1);
  await deleteAllPhotoObjectVersions(s3,bucket,target);
  const after=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:target}));assert(!after.Versions?.some(x=>x.Key===target));assert(!after.DeleteMarkers?.some(x=>x.Key===target));await assert.rejects(s3.send(new HeadObjectCommand({Bucket:bucket,Key:target})),(e:any)=>e.$metadata.httpStatusCode===404);
  for(const Key of [neighbor,control])assert.equal((await s3.send(new HeadObjectCommand({Bucket:bucket,Key}))).ContentLength,17);
  await deleteAllPhotoObjectVersions(s3,bucket,target);check('S3 removes all three actual versions and delete marker; same-prefix neighbor remains; repeated delete safe');
 }finally{
  for(const key of keys){assert(key.startsWith(photoPrefix));await deleteAllPhotoObjectVersions(s3,bucket,key);}
  const objects=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:photoPrefix}));assert.equal((objects.Versions?.length||0)+(objects.DeleteMarkers?.length||0),0);
  for(const TableName of created){assert(TableName.startsWith(prefix));await raw.send(new DeleteTableCommand({TableName}));}
  report.cleanup='S3 fixture versions absent; table deletions accepted; waiting for absence';save();
  await Promise.all(created.map(TableName=>waitUntilTableNotExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  report.cleanup='all scratch tables and all fixture S3 versions confirmed absent';writeFileSync('artifacts/system-audit-20261101/inventory-media-aws.json',JSON.stringify(report,null,2));
 }
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});
