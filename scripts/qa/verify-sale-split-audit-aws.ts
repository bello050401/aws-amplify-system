import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,CopyObjectCommand,GetObjectCommand,ListObjectVersionsCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-providers';
import {createSoldOutService} from '../../lib/inventory/soldOutCore';
import {createStockSplitService} from '../../lib/inventory/stockSplitCore';
import {createCandidateStore} from '../../lib/saleCandidates/storeCore';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {deleteAllPhotoObjectVersions} from '../../lib/mediaMaintenance/deletePhotoObject';
import {saleAmounts} from '../../lib/inventory/salePricing';
import type {SaleCandidate} from '../../lib/saleCandidates/model';

async function main(){
 assert.equal(process.env.BELLO_AUDIT_SCRATCH,'1','scratch opt-in');
 const cfg={region:'us-west-2',credentials:fromIni({profile:'Bello'}),maxAttempts:5};
 const raw=new DynamoDBClient(cfg),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}}),s3=new S3Client(cfg);
 const prefix='Bello-QA-SaleSplit-'+randomUUID().slice(0,8)+'-',table=(name:string)=>prefix+name,created:string[]=[],keys=new Set<string>();
 const bucket='bello-photo-e2e-validation-photobucket-l3bwsehg6e26',photoPrefix='photo-batches/'+randomUUID()+'/audit-sale/';
 const report={startedAt:new Date().toISOString(),passed:[] as string[],tables:created,cleanup:''};
 const save=()=>writeFileSync('artifacts/system-audit-20261101/sale-split-aws.json',JSON.stringify(report,null,2));
 const check=(s:string)=>{report.passed.push(s);save();console.log('PASS',s);};
 const get=async(name:string,id:string)=>(await db.send(new GetCommand({TableName:table(name),Key:{id},ConsistentRead:true}))).Item!;
 const count=async(name:string)=>(await db.send(new ScanCommand({TableName:table(name),Select:'COUNT',ConsistentRead:true}))).Count!;
 const now='2026-11-01T00:00:00.000Z',actor=randomUUID();
 const categories=[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'},{id:'other',name:'業者間'}];
 const copyPhotos=async(row:Record<string,unknown>,attempt:string)=>Promise.all((row.images as any[]).map(async(image,i)=>{
  const key=photoPrefix+attempt+'/'+i+'.bin';keys.add(key);
  await s3.send(new CopyObjectCommand({Bucket:bucket,Key:key,CopySource:bucket+'/'+image.storageKey}));
  return {...image,storageKey:key};
 }));
 const discardPhotos=async(images:unknown[])=>{for(const a of images as any[])await deleteAllPhotoObjectVersions(s3,bucket,a.storageKey);};
 const ports={db,table,categories:async()=>categories,nextSku:async()=>randomUUID(),copyPhotos,discardPhotos,now:()=>now};
 const persistence=createInventoryPersistence(db,table),sale=createSoldOutService(ports),split=createStockSplitService(ports);
 const seed=async(quantity:number)=>{
  const id=randomUUID(),key=photoPrefix+id+'/original.bin';keys.add(key);
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:Buffer.from('original audit photograph bytes')}));
  await persistence.persistInventoryWithCategories({id,sku:'QA-'+id,name:'【在庫'+quantity+'】椅子',quantity,barcode:'SAME-CODE',categoryIds:['active','other'],locationId:'office',purchasePrice:1234,salePrice:10000,images:[{storageKey:key,type:'NORMAL'}],createdAt:now});
  return await get('Inventory',id);
 };
 const request=(source:any,quantity:number)=>({mutationId:randomUUID(),inventoryId:source.id,expectedUpdatedAt:source.updatedAt,quantity,name:source.name,saleEndDate:'2026-11-01',externalProductId:'QA-ORDER',market:'直接取引',salePrice:10000,saleCommission:1000});
 try{
  for(const name of ['Inventory','Category','InventoryCategory','InventoryHistory','Candidates']){const TableName=table(name);await raw.send(new CreateTableCommand({TableName,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],Tags:[{Key:'Purpose',Value:'disposable-audit'}]}));created.push(TableName);}
  await Promise.all(created.map(TableName=>waitUntilTableExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  for(const c of categories)await db.send(new PutCommand({TableName:table('Category'),Item:c}));
  for(const [available,quantity] of [[1,1],[5,2],[5,5],[10,1]]){
   const source=await seed(available),before=await count('Inventory'),r=request(source,quantity),out=await sale(r,actor),sold=await get('Inventory',out.soldId);
   assert.equal(sold.quantity,quantity);assert.deepEqual(sold.categoryIds,['other','sold']);assert.equal(sold.barcode,source.barcode);assert.equal(sold.purchasePrice,1234);
   assert(await get('InventoryCategory',sold.id+':sold'));assert.equal(sold.name,'【在庫'+quantity+'】椅子');
   const remaining=await get('Inventory',source.id);
   if(quantity<available){assert.notEqual(sold.id,source.id);assert.equal(remaining.quantity,available-quantity);assert.deepEqual(remaining.categoryIds,['active','other']);assert.equal(remaining.salePrice,source.salePrice);assert.equal(remaining.saleCommission,undefined);assert.notEqual(sold.images[0].storageKey,source.images[0].storageKey);
    const a=await s3.send(new GetObjectCommand({Bucket:bucket,Key:sold.images[0].storageKey}));assert.equal(await a.Body!.transformToString(),'original audit photograph bytes');
   }else assert.equal(sold.id,source.id);
   assert.equal(await count('Inventory'),before+(quantity<available?1:0));assert.deepEqual(await sale(r,actor),out);check(`real transaction ${available}->${quantity}, totals/category/photo and idempotent receipt`);
  }
  {
   const source=await seed(5),r={mutationId:randomUUID(),inventoryId:source.id,expectedUpdatedAt:source.updatedAt,quantity:2,sourceName:'残りの商品B',splitName:'分割商品C',damageNotes:'座面に傷',barcode:'SAME-CODE',photos:[]};
   const result=await split(r,actor),child=await get('Inventory',result.splitId),parent=await get('Inventory',source.id);
   assert.equal(parent.quantity,3);assert.equal(child.quantity,2);assert.equal(parent.name,r.sourceName);assert.equal(child.name,r.splitName);assert.equal(child.damageNotes,r.damageNotes);assert.equal(child.barcode,parent.barcode);assert.notEqual(child.sku,parent.sku);assert.deepEqual(await split(r,actor),result);
   await persistence.deleteInventoryWithCategories(parent.id,parent.updatedAt,'audit');await deleteAllPhotoObjectVersions(s3,bucket,parent.images[0].storageKey);
   assert.equal(await (await s3.send(new GetObjectCommand({Bucket:bucket,Key:child.images[0].storageKey}))).Body!.transformToString(),'original audit photograph bytes');check('split titles/quantity/history and independent photo survives source deletion');
  }
  {
   const source=await seed(5),r=request(source,2),before=await count('Inventory');
   const results=await Promise.all([sale(r,actor),sale(r,actor)]);assert.deepEqual(results[0],results[1]);assert.equal((await get('Inventory',source.id)).quantity,3);assert.equal(await count('Inventory'),before+1);check('concurrent same operation creates one sold stock');
  }
  {
   const source=await seed(5),r=request(source,2),before=await count('Inventory');
   const results=await Promise.allSettled([sale(r,actor),sale({...r,mutationId:randomUUID()},actor)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await get('Inventory',source.id)).quantity,3);assert.equal(await count('Inventory'),before+1);check('concurrent different operations: only one wins');
  }
  {
   const source=await seed(5),r=request(source,2);let lost=false;
   const responseLost={send:async(c:any)=>{const result=await db.send(c);if(c instanceof TransactWriteCommand&&!lost){lost=true;throw Error('injected response loss after AWS commit');}return result;}} as typeof db;
   const run=createSoldOutService({...ports,db:responseLost}),out=await run(r,actor);assert.equal((await get('Inventory',source.id)).quantity,3);assert.deepEqual(await run(r,actor),out);check('lost HTTP response after actual commit recovers receipt without duplicate');
  }
  {
   const source=await seed(5),before=await count('Inventory'),candidate={id:'a'.repeat(64),state:'PENDING',updatedAt:now} as SaleCandidate;
   await db.send(new PutCommand({TableName:table('Candidates'),Item:{...candidate,state:'DELETED'}}));
   const run=createSoldOutService({...ports,saleCommit:(result,at)=>createCandidateStore(db,table('Candidates')).commit(candidate,actor,result,at)}),r={...request(source,2),sourceCandidateId:candidate.id};
   await assert.rejects(run(r,actor));assert.deepEqual(await get('Inventory',source.id),source);assert.equal(await count('Inventory'),before);assert.equal((await get('Candidates',candidate.id)).state,'DELETED');check('failed candidate condition rolls back stock, links and history atomically');
  }
  {
   const source=await seed(5),pricing={mode:'SET' as const,units:1,itemsPerUnit:2,unitPrice:20000,unitCommission:2000},a=saleAmounts(pricing),r={...request(source,2),...a,pricing,saleShippingReceived:3000},out=await sale(r,actor),sold=await get('Inventory',out.soldId);
   assert.equal(sold.quantity,2);assert.equal(sold.salePrice,20000);assert.equal(sold.saleCommission,2000);assert(sold.name.startsWith('【2点セット】'));assert.equal(JSON.parse(sold.customFields).__belloSale.shippingReceived,3000);assert.equal((await get('Inventory',source.id)).quantity,3);check('set sale keeps physical quantity 2, one set price/fee and separate shipping');
  }
  {const source=await seed(2),before=await count('Inventory');await assert.rejects(sale(request(source,3),actor));assert.deepEqual(await get('Inventory',source.id),source);assert.equal(await count('Inventory'),before);check('excess quantity makes no stock changes');}
 }finally{
  for(const key of keys){assert(key.startsWith(photoPrefix));await deleteAllPhotoObjectVersions(s3,bucket,key);}
  const remaining=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:photoPrefix}));assert.equal((remaining.Versions?.length||0)+(remaining.DeleteMarkers?.length||0),0);
  for(const TableName of created){assert(TableName.startsWith(prefix));await raw.send(new DeleteTableCommand({TableName}));}
  await Promise.all(created.map(TableName=>waitUntilTableNotExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  report.cleanup='all test tables and every fixture object version confirmed absent';save();
 }
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});
