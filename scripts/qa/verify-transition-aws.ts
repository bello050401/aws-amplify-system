/** Sandbox DynamoDB transactions + S3 backups. ZAICO is an in-memory test adapter. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,DescribeTableCommand,ListTagsOfResourceCommand,CreateTableCommand,DeleteTableCommand,waitUntilTableExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,DeleteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {harness} from '../verify-zaico-transition-runner';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {transitionStore,CONTROL_ID} from '../../lib/zaico/transition/store';
import type {Row} from '../../lib/zaico/transition/mapping';
async function main(){
 const dir=process.argv[2];assert.ok(dir);fs.mkdirSync(dir,{recursive:true});
 const suffix='-duwktv6y2jcm3idujer76hkmou-NONE',table=(model:string)=>model+suffix;
 const id=randomUUID(),prefix=`transition-qa-${id}-`,stateTable=`BelloZaicoTransitionQA-${id}`;
 const low=new DynamoDBClient({region:'us-west-2',maxAttempts:5}),db=DynamoDBDocumentClient.from(low,{marshallOptions:{removeUndefinedValues:true}});
 console.log('Checking sandbox tags');
 const described=await low.send(new DescribeTableCommand({TableName:table('Inventory')}));
 const tags=await low.send(new ListTagsOfResourceCommand({ResourceArn:described.Table!.TableArn!}));
 assert.ok(tags.Tags?.some(t=>t.Key==='amplify:deployment-type'&&t.Value==='sandbox'));
 const outputs=JSON.parse(fs.readFileSync('amplify_outputs.json','utf8'));
 assert.ok(String(outputs.data.url).includes('wg3g22ks65bjrfwxkysgldf6ii'));
 const bucket=outputs.storage.bucket_name,s3=new S3Client({region:'us-west-2'});
 const objects:string[]=[],masters:{table:string,id:string}[]=[],inventoryIds=new Set<string>();
 const persistence=createInventoryPersistence(db,table),h=harness();
 let madeTable=false;
 const results:string[]=[];
 try{
  console.log('Creating disposable sync-state table');
  await low.send(new CreateTableCommand({TableName:stateTable,KeySchema:[{AttributeName:'id',KeyType:'HASH'}],
   AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST',Tags:[{Key:'Purpose',Value:'Disposable BELLO transition QA'}]}));
  madeTable=true;await waitUntilTableExists({client:low,maxWaitTime:60,minDelay:2,maxDelay:3},{TableName:stateTable});
  console.log('Testing initial baseline');
  const store=transitionStore(db,stateTable);
  const control=await store.put(h.control);h.control=control as any;
  h.port.getControl=async()=>await store.get(CONTROL_ID) as any;
  h.port.saveControl=async next=>{const saved=await store.put(next,next.version);h.control=saved as any;return saved as any;};
  h.port.states=store.list;h.port.saveState=next=>store.put(next,next.version);
  const read=async(short:string):Promise<Row|undefined>=>{const row=await persistence.getInventoryRaw(prefix+short);return row?{...row,id:short}:undefined;};
  h.port.inventory=read;
  h.port.inventories=async()=>{const rows:Row[]=[];for(const short of inventoryIds){const row=await read(short);if(row)rows.push(row);}return rows;};
  h.port.saveInventory=async(row,version)=>{inventoryIds.add(row.id);await persistence.persistInventoryWithCategories({...row,id:prefix+row.id},version,{preserveZaicoSourceBarcode:true});return (await read(row.id))!;};
  h.port.deleteInventory=async row=>persistence.deleteInventoryWithCategories(prefix+row.id,row.updatedAt,'transition-qa');
  const originalResolve=h.masters.resolve;
  h.masters.resolve=async(kind,name)=>{
   const result=await originalResolve(kind,name),list=kind==='Category'?h.masters.categories:kind==='Location'?h.masters.locations:h.masters.statuses;
   const row=list.find(r=>r.id===result)!;
   if(!row.qaWritten){row.qaWritten=true;row.id=prefix+result;masters.push({table:table(kind),id:row.id});
    await db.send(new PutCommand({TableName:table(kind),Item:{id:row.id,name, label:name,code:row.id,isActive:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},ConditionExpression:'attribute_not_exists(id)'}));}
   return row.id;
  };
  h.port.archive=async(label,value)=>{
   const key=`qa/zaico-transition/${id}/${label}/${randomUUID()}.json`,body=JSON.stringify(value);objects.push(key);
   await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,IfNoneMatch:'*',ContentType:'application/json'}));
   assert.equal((await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}))).ContentLength,Buffer.byteLength(body));return key;
  };
  h.port.readArchive=async key=>{assert.ok(key.startsWith(`qa/zaico-transition/${id}/`));return JSON.parse(await (await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}))).Body!.transformToString());};
  h.seed();h.remotes.get('1')!.code=`qa-${id}`;h.remotes.get('1')!.quantity=null;
  const seed:Row={...h.rows.get('one'),id:prefix+'one',barcode:`qa-${id}`};delete seed.updatedAt;
  inventoryIds.add('one');await persistence.persistInventoryWithCategories(seed,undefined,{preserveZaicoSourceBarcode:true});
  await h.run();
  assert.equal(h.control.phase,'ACTIVE');assert.equal((await read('one'))!.quantity,undefined);assert.ok(h.control.backupKey);results.push('ZAICO初回優先・未入力数量・S3バックアップ・状態保存');
  const before=(await read('one'))!;
  await persistence.persistInventoryWithCategories({id:prefix+'one',name:'AWSテスト編集',updatedBy:'QA'},before.updatedAt);
  await h.tick();assert.equal(h.remotes.get('1')!.title,'AWSテスト編集');results.push('BELLO編集検出・送信後照合・競合防止保存');
  h.calls.length=0;await h.tick();assert.equal(h.calls.filter(c=>c.method!=='LIST').length,0);results.push('再起動相当の再取得後も変更なし再送0件');
  const c=await store.get(CONTROL_ID);
  await assert.rejects(store.put({...c,phase:'STOPPED'},'stale-version'));results.push('古い処理の上書き拒否');
  assert.equal(await store.acquire('a'),true);assert.equal(await store.acquire('b'),false);await store.release('a');results.push('同時実行の排他');
  h.remotes.get('1')!.deleted=true;await h.tick();assert.equal(await read('one'),undefined);results.push('ZAICO削除のバックアップ後削除');
  fs.writeFileSync(path.join(dir,'AWS同期実行テスト.json'),JSON.stringify({results,passed:results.length,zaicoWrites:0,productionWrites:0,sandbox:true},null,2));
  console.log(JSON.stringify({passed:results.length,results,zaicoWrites:0,productionWrites:0}));
 }finally{
  for(const short of inventoryIds){const row=await persistence.getInventoryRaw(prefix+short);if(row)await persistence.deleteInventoryWithCategories(row.id,row.updatedAt,'QA cleanup');}
  for(const master of masters)await db.send(new DeleteCommand({TableName:master.table,Key:{id:master.id}}));
  for(const key of objects){assert.ok(key.startsWith(`qa/zaico-transition/${id}/`));await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));}
  if(madeTable)await low.send(new DeleteTableCommand({TableName:stateTable}));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
