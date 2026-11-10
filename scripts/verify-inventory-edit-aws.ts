import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {DynamoDBClient,CreateTableCommand,DescribeTableCommand,waitUntilTableExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,DeleteCommand,UpdateCommand,ScanCommand,BatchWriteCommand,BatchGetCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {Agent} from 'node:https';
import {createInventoryPersistence} from '../lib/inventory/categoryPersistenceCore';
import {createInventoryEditJobs} from '../lib/inventory/editJobsCore';
import {readEditHistory} from '../lib/inventory/reversibleHistory';
import {withHumanEdits} from '../lib/inventory/humanEdits';
import {parseCustomFields} from '../lib/inventory/customFieldsCodecCore';
// These isolated tables never contain live inventory or customer information.
async function main(){
process.env.AWS_PROFILE='Bello';
const region='us-west-2',client=new DynamoDBClient({region,requestHandler:new NodeHttpHandler({httpsAgent:new Agent({keepAlive:false})})}),real=DynamoDBDocumentClient.from(client,{marshallOptions:{removeUndefinedValues:true}});
const suffix=process.env.INVENTORY_QA_SUFFIX||'BELLO-EditQA-20261109';
assert(/^BELLO-EditQA-[a-zA-Z0-9-]+$/.test(suffix));
const table=(model:string)=>model+'-'+suffix,jobsTable=table('InventoryEditJobs');
process.env.INVENTORY_EDIT_JOBS_TABLE=jobsTable;process.env.INVENTORY_HISTORY_TABLE=table('Inventory');
const metrics:Record<string,number[]>={},results:{test:string;ms:number;status:string}[]=[],report=process.env.INVENTORY_QA_REPORT||'artifacts/inventory-edit-20261109/aws-tests.json';
let lostResponse=false,failBefore=false;
const db={send:async(command:any)=>{const label=command.constructor.name,at=performance.now();if(label==='TransactWriteCommand'&&failBefore){throw Object.assign(Error('injected sustained outage before commit'),{name:'InternalServerError'});}try{const result=await real.send(command);if(label==='TransactWriteCommand'&&lostResponse){lostResponse=false;throw Object.assign(Error('injected lost response after commit'),{name:'TimeoutError'});}return result;}finally{(metrics[label]??=[]).push(performance.now()-at);}}} as unknown as DynamoDBDocumentClient;
for(const model of ['Inventory','InventoryCategory','Category','Location','InventoryEditJobs']){const name=table(model);assert(name.endsWith(suffix));try{await client.send(new DescribeTableCommand({TableName:name}));}catch(error){if((error as Error).name!=='ResourceNotFoundException')throw error;await client.send(new CreateTableCommand({TableName:name,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:model==='InventoryEditJobs'?[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]:[{AttributeName:'id',AttributeType:'S'}],KeySchema:model==='InventoryEditJobs'?[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]:[{AttributeName:'id',KeyType:'HASH'}],Tags:[{Key:'Purpose',Value:'BELLO inventory isolated correctness test'},{Key:'DeleteAfter',Value:'2026-11-16'}]}));await waitUntilTableExists({client,maxWaitTime:60},{TableName:name});}}
for(const id of ['selling','new','check','other'])await real.send(new PutCommand({TableName:table('Category'),Item:{id,name:id,isActive:true}}));
for(const id of ['L1','L2'])await real.send(new PutCommand({TableName:table('Location'),Item:{id,name:id,isActive:true}}));
const persistence=createInventoryPersistence(db,table);
const read=async(id:string)=>(await real.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item!;
const seed=async(name='チェア',categoryIds=['selling'],quantity=5)=>{const id=randomUUID(),at=new Date().toISOString();await real.send(new PutCommand({TableName:table('Inventory'),Item:{id,sku:'QA-'+id.slice(0,8),name,quantity,categoryIds,categoryId:categoryIds[0],updatedAt:at,listingPartition:'ACTIVE'}}));for(const categoryId of categoryIds)await real.send(new PutCommand({TableName:table('InventoryCategory'),Item:{id:id+':'+categoryId,inventoryId:id,categoryId}}));return id;};
const queue:string[]=[];
const runtime=createInventoryEditJobs({db,table,jobsTable,enqueue:async id=>{queue.push(id);},authorizeWorker:async owner=>owner==='QA_EDITOR',readBatch:async ids=>{if(!ids.length)return new Map();const response=await real.send(new BatchGetCommand({RequestItems:{[table('Inventory')]:{Keys:ids.map(id=>({id})),ConsistentRead:true}}}));assert.equal(response.UnprocessedKeys?.[table('Inventory')]?.Keys?.length??0,0);return new Map((response.Responses?.[table('Inventory')]??[]).map(row=>[row.id,row]));}});
async function preview(ids:string[],rules:any,mode:'edit'|'undo'|'redo'='edit',targetOperationId?:string){const id=randomUUID();await runtime.create({id,ids,mode,rules:mode==='edit'?rules:undefined,targetOperationId},'QA_EDITOR','QA_EDITOR');await runtime.run(id);return id;}
async function apply(id:string){await runtime.apply(id,'QA_EDITOR');await runtime.run(id);return runtime.status(id,'QA_EDITOR');}
const keep={categories:{mode:'keep'},names:[]};
const add=(text:string)=>({categories:{mode:'keep'},names:[{kind:'prefix',text,skipExisting:true}]});
async function test(name:string,fn:()=>Promise<void>){if(process.env.INVENTORY_QA_FILTER&&!name.includes(process.env.INVENTORY_QA_FILTER))return;const at=performance.now();await fn();results.push({test:name,ms:Math.round(performance.now()-at),status:'PASS'});console.log('PASS '+name);}
await test('直接保存：複数カテゴリ、関連リンク、無変更保存',async()=>{const id=await seed(),a=await read(id);const saved=await persistence.persistInventoryWithCategories({id,categoryIds:['selling','check']},a.updatedAt);let b=await read(id);assert.deepEqual(b.categoryIds,['selling','check']);assert.equal(b.revision,1);const links=await real.send(new ScanCommand({TableName:table('InventoryCategory'),FilterExpression:'inventoryId=:i',ExpressionAttributeValues:{':i':id}}));assert.equal(links.Items?.length,2);const noChange=await persistence.persistInventoryWithCategories({id,categoryIds:['selling','check']},saved.updatedAt);assert.equal(noChange.changed,false);b=await read(id);assert.equal(b.revision,1);assert.equal(readEditHistory(b).entries.length,1);});
await test('カテゴリ追加・解除・置換・全解除、他カテゴリ保持',async()=>{const a=await seed('A',['selling']),b=await seed('B',['selling','new']);let j=await preview([a,b],{categories:{mode:'modify',add:['check'],remove:[]},names:[]});assert.equal((await apply(j)).job.counts.SAVED,2);assert.deepEqual((await read(a)).categoryIds,['selling','check']);assert.deepEqual((await read(b)).categoryIds,['selling','new','check']);j=await preview([a,b],{categories:{mode:'modify',add:['check'],remove:['new']},names:[]});const result=await apply(j);assert.equal(result.job.counts.SAVED,1);assert.equal(result.job.counts.UNCHANGED,1);j=await preview([a,b],{categories:{mode:'replace',ids:['other']},names:[]});await apply(j);assert.deepEqual((await read(a)).categoryIds,['other']);j=await preview([a,b],{categories:{mode:'clear'},names:[]});await apply(j);assert.deepEqual((await read(a)).categoryIds,[]);assert.equal((await read(a)).categoryId,undefined);});
await test('2回戻る・2回進む・再読み込み・枝分岐・2差分上限',async()=>{const id=await seed();await apply(await preview([id],add('A')));await apply(await preview([id],add('B')));assert.equal((await read(id)).name,'BAチェア');await apply(await preview([id],keep,'undo'));await apply(await preview([id],keep,'undo'));assert.equal((await read(id)).name,'チェア');await apply(await preview([id],keep,'redo'));await apply(await preview([id],keep,'redo'));assert.equal((await read(id)).name,'BAチェア');assert.equal(readEditHistory(await read(id)).entries.length,2);await apply(await preview([id],keep,'undo'));await apply(await preview([id],add('C')));const h=readEditHistory(await read(id));assert.equal(h.cursor,2);assert.equal(h.entries.length,2);assert.equal((await read(id)).name,'CAチェア');const failed=await preview([id],keep,'redo');assert.equal((await runtime.status(failed,'QA_EDITOR')).job.counts.ERROR,1);});
await test('DB確定後の応答消失・再送・二重適用防止',async()=>{const id=await seed(),j=await preview([id],add('再送'));await runtime.apply(j,'QA_EDITOR');lostResponse=true;await runtime.run(j);await runtime.run(j);await runtime.apply(j,'QA_EDITOR');assert.equal((await read(id)).name,'再送チェア');assert.equal((await read(id)).revision,1);assert.equal((await runtime.status(j,'QA_EDITOR')).job.counts.SAVED,1);});
await test('DB確定前の継続障害・復旧後ジョブ再起動',async()=>{const id=await seed(),j=await preview([id],add('再開'));await runtime.apply(j,'QA_EDITOR');failBefore=true;try{await assert.rejects(runtime.run(j));assert.equal((await read(id)).name,'チェア');}finally{failBefore=false;}await runtime.run(j);assert.equal((await read(id)).name,'再開チェア');assert.equal((await read(id)).revision,1);});
await test('別端末更新・一括部分成功・古いプレビュー拒否',async()=>{const a=await seed(),b=await seed(),j=await preview([a,b],add('一括'));const old=await read(b);await persistence.persistInventoryWithCategories({id:b,name:'別端末'},old.updatedAt);const result=await apply(j);assert.equal(result.job.counts.SAVED,1);assert.equal(result.job.counts.CONFLICT,1);assert.equal((await read(b)).name,'別端末');});
await test('同時適用：どちらか一方だけ成功し履歴と値は一致',async()=>{const id=await seed(),a=await preview([id],add('A')),b=await preview([id],add('B'));await Promise.all([apply(a),apply(b)]);const result=await read(id);assert(['Aチェア','Bチェア'].includes(result.name));assert.equal(result.revision,1);assert.equal(readEditHistory(result).entries.length,1);});
await test('不正括弧は全体適用を止める・明示除外後のみ保存',async()=>{const a=await seed('チェア（展示品）'),b=await seed('チェア（未完');const rules={categories:{mode:'keep'},names:[{kind:'brackets',bracket:'wide',content:false}]};const j=await preview([a,b],rules);await assert.rejects(runtime.apply(j,'QA_EDITOR'));assert.equal((await read(a)).name,'チェア（展示品）');await apply(await preview([a],rules));assert.equal((await read(a)).name,'チェア展示品');assert.equal((await read(b)).name,'チェア（未完');});
await test('別ユーザー参照・再利用ID改変・履歴飛び越えを拒否',async()=>{const id=await seed(),j=await preview([id],add('A'));await assert.rejects(runtime.status(j,'OTHER'));await assert.rejects(runtime.create({id:j,ids:[id],mode:'edit',rules:add('B') as any},'QA_EDITOR','QA_EDITOR'));await apply(j);await apply(await preview([id],add('B')));const undo=await preview([id],keep,'undo',j);assert.equal((await runtime.status(undo,'QA_EDITOR')).job.counts.ERROR,1);});
await test('100件プレビュー・保存・再送、数量不変',async()=>{const ids=await Promise.all(Array.from({length:100},(_,i)=>seed('試験'+i)));const j=await preview(ids,{categories:{mode:'modify',add:['check'],remove:[]},names:[{kind:'prefix',text:'【確認】',skipExisting:true}]});const result=await apply(j);assert.equal(result.job.counts.SAVED,100);await runtime.run(j);for(const id of ids){const r=await read(id);assert.equal(r.quantity,5);assert.equal(r.revision,1);assert.equal(readEditHistory(r).entries.length,1);}});
await test('適用前キャンセル・実行受付直後キャンセルで在庫は不変',async()=>{
 const id=await seed(),first=await preview([id],add('取消'));
 await runtime.cancel(first,'QA_EDITOR');await runtime.run(first);await assert.rejects(runtime.apply(first,'QA_EDITOR'));
 assert.equal((await read(id)).name,'チェア');assert.equal((await runtime.status(first,'QA_EDITOR')).job.state,'CANCELLED');
 const second=await preview([id],add('取消'));await runtime.apply(second,'QA_EDITOR');await runtime.cancel(second,'QA_EDITOR');await runtime.run(second);
 assert.equal((await read(id)).name,'チェア');assert.equal((await runtime.status(second,'QA_EDITOR')).job.counts.SAVED??0,0);
});
await test('一時結果の削除後も2差分・一括操作対象を保持、後続編集を検出',async()=>{
 const a=await seed(),b=await seed(),op=await preview([a,b],add('一括'));await apply(op);
 await real.send(new DeleteCommand({TableName:jobsTable,Key:{pk:'EDIT#'+op,sk:'META'}}));
 assert.deepEqual((await runtime.operationTargets(op)).ids,[a,b].sort());
 assert.equal(readEditHistory(await read(a)).entries[0].operationId,op);
 await apply(await preview([b],add('後続')));
 const undo=await preview([a,b],keep,'undo',op);assert.equal((await runtime.status(undo,'QA_EDITOR')).job.counts.ERROR,1);
 await assert.rejects(runtime.apply(undo,'QA_EDITOR'));assert.equal((await read(a)).name,'一括チェア');
});
await test('2差分から外れた操作の参照を同時削除、未適用の操作は参照なし',async()=>{
 const id=await seed(),a=await preview([id],add('A'));await apply(a);
 const b=await preview([id],add('B'));await apply(b);const c=await preview([id],add('C'));await apply(c);
 const ref=async(op:string)=>(await real.send(new GetCommand({TableName:jobsTable,Key:{pk:'OP#'+op,sk:'REF#'+id},ConsistentRead:true}))).Item;
 assert.equal(await ref(a),undefined);assert(await ref(b));assert(await ref(c));
 const d=await preview([id],add('D'));assert.equal(await ref(d),undefined);
});
await test('プレビュー後に無効化されたカテゴリを付与せず、既存の無効カテゴリは保持',async()=>{
 const id=await seed(),category='retired-'+randomUUID();await real.send(new PutCommand({TableName:table('Category'),Item:{id:category,isActive:true}}));
 const j=await preview([id],{categories:{mode:'modify',add:[category],remove:[]},names:[]});
 await real.send(new UpdateCommand({TableName:table('Category'),Key:{id:category},UpdateExpression:'SET isActive=:no',ExpressionAttributeValues:{':no':false}}));
 assert.equal((await apply(j)).job.counts.SAVED??0,0);assert.deepEqual((await read(id)).categoryIds,['selling']);
 const existing=await seed('旧カテゴリあり',['selling',category]);
 await apply(await preview([existing],add('確認')));
 assert.deepEqual((await read(existing)).categoryIds,['selling',category]);
});
await test('途中で実行時間を区切って再開、進捗のみ取得、権限失効は保存禁止',async()=>{
 const id=await seed(),j=randomUUID();await runtime.create({id:j,ids:[id],mode:'edit',rules:add('継続') as any},'QA_EDITOR','QA_EDITOR');
 assert.equal((await runtime.run(j,()=>true)).state,'PREPARING');
 assert.deepEqual((await runtime.status(j,'QA_EDITOR',false)).rows,[]);
 await runtime.run(j);await runtime.apply(j,'QA_EDITOR');assert.equal((await runtime.run(j,()=>true)).state,'APPLYING');
 assert.equal((await read(id)).name,'チェア');await runtime.run(j);assert.equal((await read(id)).name,'継続チェア');assert.equal((await read(id)).revision,1);
 const denied=randomUUID();await runtime.create({id:denied,ids:[id],mode:'edit',rules:add('拒否') as any},'QA_VIEWER','QA_VIEWER');
 assert.equal((await runtime.run(denied)).state,'FAILED');assert.equal((await read(id)).name,'継続チェア');
});
await test('保管場所・カテゴリ同時保存、履歴で復元、無効場所・到着待ちを拒否',async()=>{
 const id=await seed('場所試験'),initial=await read(id);
 await persistence.persistInventoryWithCategories({id,locationId:'L1'},initial.updatedAt);
 const rules={categories:{mode:'modify',add:['check'],remove:[]},names:[],location:{mode:'set',id:'L2'}};
 const j=await preview([id],rules);assert.equal((await apply(j)).job.counts.SAVED,1);
 const saved=await read(id);assert.equal(saved.locationId,'L2');assert.deepEqual(saved.categoryIds,['selling','check']);
 await apply(await preview([id],keep,'undo'));assert.equal((await read(id)).locationId,'L1');assert.deepEqual((await read(id)).categoryIds,['selling']);
 await apply(await preview([id],keep,'redo'));assert.equal((await read(id)).locationId,'L2');
 const invalid=await preview([id],{...rules,location:{mode:'set',id:'missing'}});assert.equal((await runtime.status(invalid,'QA_EDITOR')).job.counts.ERROR,1);
 await real.send(new UpdateCommand({TableName:table('Inventory'),Key:{id},UpdateExpression:'SET outboundArrivalBatchId=:b',ExpressionAttributeValues:{':b':'qa-transit'}}));
 const transit=await preview([id],{...keep,location:{mode:'set',id:'L1'}});assert.equal((await runtime.status(transit,'QA_EDITOR')).job.counts.ERROR,1);
});
await test('一覧の寸法・日付・追加項目を保存し、再取得と戻る・進むで完全復元',async()=>{
 const id=await seed(),first=await read(id);
 const priorCustom={color:'赤',memo:'スタッフの記録',__restageImport:{sourceId:'qa-only'}};
 await persistence.persistInventoryWithCategories({id,width:'60',saleEndDate:null,customFields:JSON.stringify(priorCustom)},first.updatedAt);
 const before=await read(id),custom=parseCustomFields(before.customFields)!;
 const values={width:'71.5',saleEndDate:'2026-11-10',categoryIds:['selling','check']};
 await persistence.persistInventoryWithCategories({id,...values,customFields:JSON.stringify(withHumanEdits(before,values,custom,{...custom,color:'青'}))},before.updatedAt);
 const saved=await read(id);assert.equal(saved.width,'71.5');assert.equal(saved.saleEndDate,'2026-11-10');
 assert.deepEqual(saved.categoryIds,['selling','check']);assert.equal(parseCustomFields(saved.customFields)!.color,'青');
 assert.equal(parseCustomFields(saved.customFields)!.memo,'スタッフの記録');
 assert.deepEqual(parseCustomFields(saved.customFields)!.__restageImport,{sourceId:'qa-only'});
 await apply(await preview([id],keep,'undo'));const undone=await read(id);
 assert.equal(undone.width,'60');assert.equal(undone.saleEndDate,before.saleEndDate);assert.equal(Object.hasOwn(undone,'saleEndDate'),Object.hasOwn(before,'saleEndDate'));assert.equal(parseCustomFields(undone.customFields)!.color,'赤');
 assert.deepEqual(undone.categoryIds,['selling']);
 await apply(await preview([id],keep,'redo'));const redone=await read(id);
 assert.equal(redone.width,'71.5');assert.equal(redone.saleEndDate,'2026-11-10');assert.equal(parseCustomFields(redone.customFields)!.color,'青');
 assert.equal(readEditHistory(redone).entries.length,2);
});
mkdirSync('artifacts/inventory-edit-20261109',{recursive:true});
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
writeFileSync(report,JSON.stringify({at:new Date().toISOString(),environment:'isolated AWS DynamoDB us-west-2; Windows Japan to US-West; no production writes',tables:['Inventory','Category','Location','InventoryCategory','InventoryEditJobs'].map(table),results,metrics:Object.fromEntries(Object.entries(metrics).map(([name,values])=>[name,{n:values.length,p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99)}]))},null,2));console.log('RESULT '+results.length+' PASS '+report);

}
main().catch(error=>{console.error(error);process.exitCode=1;});
