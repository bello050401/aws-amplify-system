import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,QueryCommand,TransactWriteCommand,BatchGetCommand,DeleteCommand} from '@aws-sdk/lib-dynamodb';
import {createQuantityTransfer,transferQuantities} from '../../lib/inventory/quantityTransfer';
import {createSelectionDeleteJobs} from '../../lib/inventory/selectionDeleteJobs';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {createInventoryEditJobs} from '../../lib/inventory/editJobsCore';
import {createPreferenceStore} from '../../lib/inventory/preferenceStore';
import {readEditHistory,moveInventoryHistory} from '../../lib/inventory/reversibleHistory';
import {transformInventoryEdit} from '../../lib/inventory/editTransform';
import {historyChangeDetails,historyQuantity} from '../../lib/inventory/historyDisplay';
import {importedStockTitle,STOCK_TITLE_META} from '../../lib/inventory/managedStockTitle';
const suffix='BELLO-EditQA-20261109',table=(name:string)=>name+'-'+suffix;
process.env.INVENTORY_EDIT_JOBS_TABLE=table('InventoryEditJobs');process.env.INVENTORY_HISTORY_TABLE=table('Inventory');
const real=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}),{marshallOptions:{removeUndefinedValues:true}});
let fault:'none'|'before'|'after'='none';const trace:string[]=[];
const db={send:async(command:any)=>{
 const input=command.input, tables=[input.TableName,...Object.keys(input.RequestItems??{}),...(input.TransactItems??[]).map((i:any)=>(i.Put??i.Update??i.Delete??i.ConditionCheck).TableName)].filter(Boolean);
 assert(tables.every(t=>t.endsWith('-'+suffix)),'Production table access forbidden');
 trace.push(command.constructor.name);
 if(command instanceof TransactWriteCommand&&fault==='before'){fault='none';throw Error('Synthetic database outage');}
 const result=await real.send(command);
 if(command instanceof TransactWriteCommand&&fault==='after'){fault='none';throw Error('Synthetic lost response after commit');}
 return result;
}} as unknown as DynamoDBDocumentClient;
const store=createInventoryPersistence(db,table), owner='QA-PARITY-'+randomUUID(), created:string[]=[],results:{name:string;ms:number}[]=[];
async function test(name:string,fn:()=>void|Promise<void>){const start=performance.now();await fn();results.push({name,ms:performance.now()-start});console.log('PASS '+name);}
async function row(id:string){return (await db.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item;}
async function seed(quantity:number,extra:Record<string,unknown>={}){const id=randomUUID(),title=importedStockTitle('匿名チェア',quantity,'脚','qa');await store.persistInventoryWithCategories({id,name:title.name,quantity,unit:'点',categoryIds:[],customFields:JSON.stringify({[STOCK_TITLE_META]:title.metadata,memo:'保持'}),locationId:'QA-L1',listingPartition:'ACTIVE',...extra});created.push(id);return (await row(id))!;}
async function transferFixture(){const a=await seed(5),b=await seed(2);return {a,b,r:{operationId:randomUUID(),sourceId:a.id,targetId:b.id,sourceVersion:a.updatedAt,targetVersion:b.updatedAt,quantity:2}};}
const transfer=createQuantityTransfer({db,table});
async function main(){try{
 await test('数量移動: 5→3 / 2→4、合計・カテゴリ・場所・タイトルを維持',async()=>{const {a,b,r}=await transferFixture();assert.deepEqual(await transfer(r,owner),{source:3,target:4});const [x,y]=await Promise.all([row(a.id),row(b.id)]);assert.equal(x!.name,'【在庫3】匿名チェア');assert.equal(y!.name,'【在庫4】匿名チェア');assert.equal(x!.locationId,'QA-L1');assert.deepEqual(x!.categoryIds,[]);assert.equal(JSON.parse(x!.customFields).memo,'保持');assert.throws(()=>moveInventoryHistory(x!,'undo'));assert(readEditHistory(x!).entries.length<=2);});
 await test('数量移動: 同じ操作番号の再送は再減算しない',async()=>{const {a,r}=await transferFixture();await transfer(r,owner);await transfer(r,owner);assert.equal((await row(a.id))!.quantity,3);await assert.rejects(()=>transfer({...r,quantity:1},owner));});
 await test('数量移動: 更新競合では両商品とも変更しない',async()=>{const {a,b,r}=await transferFixture();await store.persistInventoryWithCategories({id:b.id,note:'別スタッフ更新'},b.updatedAt);await assert.rejects(()=>transfer(r,owner));assert.equal((await row(a.id))!.quantity,5);assert.equal((await row(b.id))!.quantity,2);});
 await test('数量移動: DB失敗で片側だけ変更しない、同一要求で再試行',async()=>{const {a,b,r}=await transferFixture();fault='before';await assert.rejects(()=>transfer(r,owner));assert.equal((await row(a.id))!.quantity,5);assert.equal((await row(b.id))!.quantity,2);await transfer(r,owner);});
 await test('数量移動: 確定後の応答消失でも保存結果を照合',async()=>{const {a,r}=await transferFixture();fault='after';assert.deepEqual(await transfer(r,owner),{source:3,target:4});await transfer(r,owner);assert.equal((await row(a.id))!.quantity,3);});
 await test('数量移動: 予約・単位相違・超過・未入力を拒否',async()=>{for(const extra of [{outboundArrivalBatchId:'QA'},{outboundBatchId:'QA'},{unit:'脚'},{quantity:null,customFields:'{}'}]){const a=await seed(5),b=await seed(2,extra);await assert.rejects(()=>transfer({operationId:randomUUID(),sourceId:a.id,targetId:b.id,sourceVersion:a.updatedAt,targetVersion:b.updatedAt,quantity:1},owner));assert.equal((await row(a.id))!.quantity,5);}assert.throws(()=>transferQuantities(1,2,2));assert.throws(()=>transferQuantities(1,2147483647,1));});
 const readBatch=async(ids:string[])=>{const r=await db.send(new BatchGetCommand({RequestItems:{[table('Inventory')]:{Keys:ids.map(id=>({id})),ConsistentRead:true}}}));assert(!r.UnprocessedKeys?.[table('Inventory')]?.Keys?.length);return new Map((r.Responses?.[table('Inventory')]??[]).map(r=>[r.id,r]));};
 const edits=createInventoryEditJobs({db,table,jobsTable:table('InventoryEditJobs'),readBatch,enqueue:async()=>{},authorizeWorker:async()=>true});
 await test('入庫: プレビュー後に5+2=7、再送でも7、戻る/進むで復元',async()=>{const a=await seed(5),id=randomUUID();await edits.create({id,ids:[a.id],mode:'edit',rules:{categories:{mode:'keep'},names:[],quantityIncrease:2}},owner,owner);await edits.run(id);assert.equal((await row(a.id))!.quantity,5);await edits.apply(id,owner);await edits.run(id);await edits.run(id);assert.equal((await row(a.id))!.quantity,7);assert.equal((await edits.status(id,owner)).job.counts.SAVED,1);for(const mode of ['undo','redo'] as const){const op=randomUUID();await edits.create({id:op,ids:[a.id],mode},owner,owner);await edits.run(op);await edits.apply(op,owner);await edits.run(op);assert.equal((await row(a.id))!.quantity,mode==='undo'?5:7);}});
 await test('入庫: 不明数量や同時上書きを拒否',()=>{for(const quantity of [null,undefined,-1])assert.throws(()=>transformInventoryEdit({name:'匿名',categoryIds:[],quantity},{categories:{mode:'keep'},names:[],quantityIncrease:2}));assert.throws(()=>transformInventoryEdit({name:'匿名',categoryIds:[],quantity:5},{categories:{mode:'keep'},names:[],quantityIncrease:2,fields:{quantity:1}}));});
 let allowed=true;const deletion=createSelectionDeleteJobs({db,table,jobsTable:table('InventoryEditJobs'),enqueue:async()=>{},authorize:async()=>allowed});
 const target=(r:any)=>({id:r.id,updatedAt:r.updatedAt,name:r.name,sku:'QA'});
 await test('一括削除: 在庫・カテゴリ関連・結果の同時確定、重複実行',async()=>{const cat='QA-'+randomUUID();await db.send(new PutCommand({TableName:table('Category'),Item:{id:cat,name:'検証',isActive:true}}));const a=await seed(1,{categoryIds:[cat]}),id=randomUUID();await deletion.create(id,[target(a)],owner);await deletion.run(id);await deletion.run(id);assert.equal(await row(a.id),undefined);assert.equal((await db.send(new GetCommand({TableName:table('InventoryCategory'),Key:{id:a.id+':'+cat}}))).Item,undefined);assert.equal((await deletion.status(id,owner)).items[0].state,'SAVED');await db.send(new DeleteCommand({TableName:table('Category'),Key:{id:cat}}));});
 await test('一括削除: 確定後応答消失でも結果SAVED、再送安全',async()=>{const a=await seed(1),id=randomUUID();await deletion.create(id,[target(a)],owner);fault='after';await deletion.run(id);assert.equal((await deletion.status(id,owner)).items[0].state,'SAVED');assert.equal(await row(a.id),undefined);});
 await test('一括削除: 競合・到着待ちを保持し、対象外は削除しない',async()=>{const a=await seed(1),b=await seed(1,{outboundArrivalBatchId:'QA'}),c=await seed(1),id=randomUUID();await deletion.create(id,[target(a),target(b)],owner);await store.persistInventoryWithCategories({id:a.id,note:'後の編集'},a.updatedAt);await deletion.run(id);const r=await deletion.status(id,owner);assert.equal(r.items.find(i=>i.id===a.id)!.state,'CONFLICT');assert.equal(r.items.find(i=>i.id===b.id)!.state,'FAILED');for(const x of [a,b,c])assert(await row(x.id));});
 await test('一括削除: 他利用者は結果取得・再開不可、実行時権限失効で停止',async()=>{const a=await seed(1),id=randomUUID();await deletion.create(id,[target(a)],owner);await assert.rejects(()=>deletion.status(id,'OTHER'));await assert.rejects(()=>deletion.resume(id,'OTHER'));allowed=false;await deletion.run(id);allowed=true;assert.equal((await deletion.status(id,owner)).items[0].state,'FAILED');assert(await row(a.id));});
 const prefs=createPreferenceStore(db,table('InventoryEditJobs'));
 await test('表示設定: 同一アカウントで保存・再取得、他利用者へ混入しない',async()=>{assert.deepEqual(await prefs.save(owner,'density',0,'compact'),{revision:1});assert.equal((await prefs.get(owner)).density.value,'compact');assert.equal((await prefs.get('OTHER')).density,null);});
 await test('表示設定: 再送・競合・上限、4区分だけを保存',async()=>{assert.deepEqual(await prefs.save(owner,'density',0,'compact'),{revision:1});await assert.rejects(()=>prefs.save(owner,'density',0,'normal'));assert.equal((await prefs.get(owner)).density.value,'compact');await assert.rejects(()=>prefs.save(owner,'unbounded' as any,0,{}));await assert.rejects(()=>prefs.save(owner,'searches',0,Array(11).fill({id:'x',name:'x',query:''})));await prefs.save(owner,'density',1,'normal');assert.equal((await prefs.get(owner)).density.revision,2);});
 await test('数量履歴: JSON移動履歴・0をグラフに含め、不明値は除外',()=>{assert.equal(historyQuantity({fieldName:'数量移動',newValue:'{"quantity":3}'}),3);assert.equal(historyQuantity({fieldName:'数量',newValue:'0'}),0);assert.equal(historyQuantity({fieldName:'数量',newValue:''}),null);const d=historyChangeDetails({fieldName:'移動',oldValue:'{"categoryIds":["c"]}',newValue:'{"categoryIds":[],"hash":"secret","requestId":"internal"}'},{categories:[{id:'c',name:'販売中'}]});assert.equal(d[0].before,'販売中');assert.equal(d.length,1);});
}finally{
 for(const id of created){const existing=await row(id);if(existing)await db.send(new DeleteCommand({TableName:table('Inventory'),Key:{id}}));}
 mkdirSync('artifacts/parity-20261111',{recursive:true});writeFileSync('artifacts/parity-20261111/aws-tests.json',JSON.stringify({at:new Date().toISOString(),scope:'isolated AWS DynamoDB only; no production inventory or EC mutations',passed:results.length,results,requests:trace.length},null,2));
}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
