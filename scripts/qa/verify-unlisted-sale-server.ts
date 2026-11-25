import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {GetCommand,ScanCommand,BatchGetCommand,UpdateCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createSoldOutService} from '../../lib/inventory/soldOutCore';
import * as input from '../../lib/inventory/soldOutInput';
import * as locks from '../../lib/saleCandidates/automationStockLock';
import {createCandidateStore} from '../../lib/saleCandidates/storeCore';
import {applyInventoryUpdateExpression} from '../../lib/inventory/historyTransaction';
import {yahooPaymentPlan} from '../../lib/saleCandidates/yahooPaymentModel';

const compiled=new Map<string,string>();
async function load(file:string,mods:Record<string,unknown>){
 if(!compiled.has(file)){
  const result=await build({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});
  compiled.set(file,result.outputFiles[0].text);
 }
 const module={exports:{}};
 vm.runInNewContext(compiled.get(file)!,{module,exports:module.exports,require:(key:string)=>{assert.ok(key in mods,'Unexpected dependency '+key);return mods[key];},console,Date,Map,Set});
 return module.exports as any;
}
async function fixture(quantity=3){
 const id=randomUUID(),at='2026-11-25T00:00:00.000Z',candidateId='a'.repeat(64);
 let rows=new Map<string,any>([['Inventory/'+id,{id,quantity,name:'椅子',sku:'B1',updatedAt:at,categoryId:'active',categoryIds:['active'],customFields:'{}',images:[],market:'',externalProductId:''}],...['active','sold'].map(id=>['Category/'+id,{id}]) as [string,any][]]);
 const state={role:'ADMIN',sessionRole:'ADMIN',owner:'admin',external:0,transactions:0,copies:0,lost:false,beforeCommit:null as null|(()=>void),scanCount:0,reads:[] as any[]};
 const key=(table:string,k:any)=>table+'/'+(k.id??k.pk);
 const conflict=()=>Object.assign(Error('condition'),{name:'TransactionCanceledException'});
 function check(op:any,current:any){
  const names=op.ExpressionAttributeNames??{},values=op.ExpressionAttributeValues??{};
  const expression=(op.ConditionExpression??'').replace(/#\w+/g,(x:string)=>names[x]??x);
  for(const m of expression.matchAll(/attribute_not_exists\((\w+)\)/g))if(current?.[m[1]]!==undefined)throw conflict();
  for(const m of expression.matchAll(/\b(\w+)\s*=\s*(:\w+)/g))if(current?.[m[1]]!==values[m[2]])throw conflict();
 }
 const db={send:async(command:any)=>{
  const p=command.input;
  if(command instanceof GetCommand){state.reads.push(p);return {Item:structuredClone(rows.get(key(p.TableName,p.Key)))};}
  if(command instanceof ScanCommand){assert.equal(p.ConsistentRead,true);return {Items:[...rows].filter(([k,r])=>k.startsWith(p.TableName+'/')&&r.inventoryId===p.ExpressionAttributeValues[':id']).map(([,r])=>({id:r.id})),ScannedCount:state.scanCount};}
  if(command instanceof BatchGetCommand)return {Responses:Object.fromEntries(Object.entries(p.RequestItems).map(([table,r]:[string,any])=>[table,r.Keys.map((k:any)=>rows.get(key(table,k))).filter(Boolean)]))};
  if(command instanceof UpdateCommand){const k=key(p.TableName,p.Key),row=rows.get(k);check(p,row);rows.set(k,applyInventoryUpdateExpression(row??p.Key,p));return {};}
  assert.ok(command instanceof TransactWriteCommand);
  state.beforeCommit?.();state.beforeCommit=null;
  for(const item of p.TransactItems){const op=item.ConditionCheck??item.Update??item.Put??item.Delete;check(op,rows.get(key(op.TableName,op.Key??op.Item)));}
  const staged=new Map(rows);
  for(const item of p.TransactItems){
   if(item.Put)staged.set(key(item.Put.TableName,item.Put.Item),structuredClone(item.Put.Item));
   if(item.Delete)staged.delete(key(item.Delete.TableName,item.Delete.Key));
   if(item.Update){const u=item.Update,k=key(u.TableName,u.Key);staged.set(k,applyInventoryUpdateExpression(staged.get(k)??u.Key,u));}
  }
  rows=staged;state.transactions++;
  if(state.lost)throw Error('lost response');
  return {};
 }} as unknown as DynamoDBDocumentClient;
 const guard=await load('lib/inventory/unlistedSaleGuard.ts',{'server-only':{},'@aws-sdk/lib-dynamodb':{GetCommand,ScanCommand},'./soldOutInput':input,'./categoryPersistence':{inventoryDdb:db,inventoryTable:(s:string)=>s},'../listing/econveni/runtimeStore':{ECONVENI_WORKFLOW_TABLE:'EC'}});
 const verify=guard.createUnlistedSaleGuard(db,(s:string)=>s,'EC');
 const store=createCandidateStore(db,'Candidates');
 const external=async()=>{state.external++;throw Error('External EC must not run');};
 const action=await load('app/actions/soldOut.ts',{
  'next/cache':{revalidatePath:()=>{}},'@/lib/amplify/requireInventoryUser':{getInventoryRole:async()=>state.role},
  '@/lib/inventory/categoryPersistence':{inventoryDdb:db,inventoryTable:(s:string)=>s,getInventoryRaw:async(id:string)=>rows.get('Inventory/'+id)},
  '@/lib/inventory/queries':{listCategories:async()=>[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'}]},'@/lib/inventory/inventoryPage':{clearInventoryCountCache:()=>{}},
  '@/lib/amplify/dataClient':{serverDataClient:{mutations:{generateInventorySku:async()=>({data:'NEW'})}},inventoryAuthMode:{}},
  '@/lib/inventory/soldOutCore':{createSoldOutService},'@/lib/inventory/soldOutPhotos':{copySoldOutPhotos:async()=>{state.copies++;return [];},discardSoldOutPhotos:async()=>{}},
  '@/lib/inventory/soldOutInput':input,'@/lib/inventory/unlistedSaleGuard':{verifyUnlistedSale:verify},'@/lib/inventory/mutationSession':{inventoryMutationSession:async()=>({role:state.sessionRole,owner:state.owner})},
  '@/lib/saleCandidates/store':{candidateStore:()=>store,candidateConfig:()=>({tableName:'Candidates'})},'@/lib/saleCandidates/yahooPaymentModel':{yahooPaymentPlan},
  '@/lib/saleCandidates/saleBinding':{ensureAutomaticSaleBinding:external},'@/lib/listing/econveni/saleAdjustment':{refreshSaleBinding:external},'@/lib/saleCandidates/desktopJobs':{verifyMercariSale:external},'@/lib/saleCandidates/automationStockLock':locks,
 });
 const request:input.SoldOutRequest={inventoryId:id,mutationId:randomUUID(),expectedUpdatedAt:at,quantity:1,name:'売却した椅子',saleEndDate:'2026-11-25',externalProductId:'invoice-1',market:'直接取引',salePrice:5000,saleCommission:0,withoutEconveniListing:true};
 const candidate=(channel='DIRECT',source='INVOICE')=>{rows.set('Candidates/'+candidateId,{id:candidateId,channel,source,state:'PENDING',updatedAt:at,orderId:'invoice-1',identifierType:'INVOICE'});request.sourceCandidateId=candidateId;};
 const legacy=createSoldOutService({db,table:s=>s,categories:async()=>[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'}],nextSku:async()=>'NEW',copyPhotos:async()=>[],discardPhotos:async()=>{}});
 return {id,at,candidateId,state,request,candidate,verify,legacy,run:(r=request)=>action.registerSoldOut(r),get:(k:string)=>rows.get(k),put:(k:string,r:any)=>rows.set(k,r)};
}

for(const amount of [1,3])test(`actual admin action + service: sell ${amount}/3, audit, retry and stock conservation`,async()=>{
 const f=await fixture();f.request.quantity=amount;f.state.lost=true;
 const out=await f.run();assert.equal(out.ok,true);const r=out.result;
 assert.equal(r.withoutEconveniListing,true);assert.equal(r.remainingQuantity,3-amount);
 const sold=f.get('Inventory/'+r.soldId);assert.equal(sold.quantity,amount);assert.equal(JSON.parse(sold.customFields).__belloSale.withoutEconveniListing,true);
 const history=JSON.parse(f.get('InventoryHistory/SOLD_OUT:'+f.request.mutationId).newValue);assert.equal(history.result.withoutEconveniListing,true);
 if(amount<3){assert.equal(f.get('Inventory/'+f.id).quantity,3-amount);assert.equal(JSON.parse(f.get('Inventory/'+f.id).customFields).__belloSale,undefined);}
 f.put('Candidates/AUTOMATION_STOCK_LOCK:'+f.id,{id:'AUTOMATION_STOCK_LOCK:'+f.id,candidateId:'later-sale',saleStarted:true});
 assert.deepEqual(await f.run(),out);assert.equal(f.state.transactions,1);assert.equal(f.state.external,0);
 assert.equal((await f.run({...f.request,withoutEconveniListing:false})).ok,false);
});
test('DIRECT invoice commit atomically releases only its stock lock and persists result',async()=>{
 const f=await fixture();f.candidate();const out=await f.run();assert.equal(out.ok,true);
 assert.equal(f.get('Candidates/'+f.candidateId).result.withoutEconveniListing,true);
 assert.equal(f.get('Candidates/AUTOMATION_STOCK_LOCK:'+f.id).candidateId,undefined);
 assert.deepEqual(await f.run(),out);assert.equal(f.state.transactions,1);assert.equal(f.state.external,0);
});
test('actual action rejects online candidate forged as direct, malformed mode and non-admin',async()=>{
 for(const channel of ['BASE','MERCARI','YAHOO']){const f=await fixture();f.candidate(channel,'GMAIL');assert.equal((await f.run()).code,'INVALID');assert.equal(f.state.transactions,0);assert.equal(f.state.external,0);}
 for(const mode of ['true',1,null]){const f=await fixture();assert.equal((await f.run({...f.request,withoutEconveniListing:mode as any})).code,'INVALID');assert.equal(f.state.transactions,0);}
 for(const field of ['role','sessionRole'] as const){const f=await fixture();f.state[field]='USER';assert.equal((await f.run()).code,'FORBIDDEN');assert.equal(f.state.reads.length,0);}
 for(const market of ['ベイス','メルカリSHOP','ヤフオク','メルカリ','ラクマ','バッタヤライブ']){const f=await fixture();assert.equal((await f.run({...f.request,market})).code,'INVALID');assert.equal(f.state.external,0);}
});
test('default path still requires binding; absent and false modes share legacy receipt digest',async()=>{
 const f=await fixture();assert.equal((await f.run({...f.request,withoutEconveniListing:false})).ok,false);assert.equal(f.state.external,1);
 // Core-level legacy receipts predate the explicit mode and must remain replayable.
 const legacy=await fixture();const request={...legacy.request,withoutEconveniListing:undefined};
 const result=await legacy.legacy(request,'admin');assert.deepEqual(await legacy.legacy({...request,withoutEconveniListing:false},'admin'),result);assert.equal(legacy.state.transactions,1);
});
test('local guard allows untouched drafts and binds their exact revisions without EC access',async()=>{
 const f=await fixture();f.put('EC/ECONVENI#INVENTORY#'+f.id,{revision:2,save:{state:'NOT_STARTED'},channels:{YAHOO:{state:'NOT_STARTED'},MERCARI_SHOPS:{state:'NOT_STARTED'}}});
 f.put('ChannelListing/ec-base-'+f.id,{id:'ec-base-'+f.id,inventoryId:f.id,status:'DRAFT',updatedAt:'draft-v1'});
 const checks=await f.verify(f.id);assert.equal(checks.length,3);assert.equal(checks[0].ConditionCheck.ExpressionAttributeValues[':r'],2);assert.equal(checks[2].ConditionCheck.ExpressionAttributeValues[':v'],'draft-v1');
 assert.equal((await f.run()).ok,true);assert.ok(f.state.reads.every(r=>r.ConsistentRead===true));assert.equal(f.state.external,0);
});
test('local guard rejects linkage history, published/uncertain operations and legacy native listings',async()=>{
 for(const [key,row] of [
  ['EC/ECONVENI#MANUAL_LINK#',{productId:'123',disabled:true}],
  ['EC/ECONVENI#INVENTORY#',{revision:1,save:{state:'PENDING'},channels:{}}],
  ['EC/ECONVENI#INVENTORY#',{revision:1,save:{state:'SUCCEEDED',productId:'123'},channels:{}}],
 ] as const){const f=await fixture();f.put(key+f.id,row);assert.equal((await f.run()).code,'INVALID');assert.equal(f.state.transactions,0);}
 for(const status of ['ACTIVE','PUBLISHING','ERROR','PAUSED','ENDED']){const f=await fixture();f.put('ChannelListing/legacy-random',{id:'legacy-random',inventoryId:f.id,status,updatedAt:'v1'});assert.equal((await f.run()).code,'INVALID');assert.equal(f.state.transactions,0);}
 const f=await fixture();f.state.scanCount=20001;const out=await f.run();assert.equal(out.code,'UNCONFIRMED');assert.match(out.error,/確認が完了しません/);
});
test('transaction fences reject concurrent BASE create, manual linkage and stock owner; stale input never writes',async()=>{
 for(const race of ['base','link','stock']){
  const f=await fixture();f.state.beforeCommit=()=>race==='base'?f.put('ChannelListing/ec-base-'+f.id,{id:'ec-base-'+f.id,status:'PUBLISHING'}):race==='link'?f.put('EC/ECONVENI#MANUAL_LINK#'+f.id,{pk:'ECONVENI#MANUAL_LINK#'+f.id,productId:'123'}):f.put('Candidates/AUTOMATION_STOCK_LOCK:'+f.id,{candidateId:'other',saleStarted:true});
  assert.equal((await f.run()).code,'CONFLICT',race);assert.equal(f.state.transactions,0);assert.equal(f.get('Inventory/'+f.id).quantity,3);assert.equal(f.state.external,0);
 }
 const f=await fixture();f.request.expectedUpdatedAt='2026-11-24T00:00:00.000Z';assert.equal((await f.run()).code,'CONFLICT');assert.equal(f.state.transactions,0);assert.equal(f.state.copies,0);
});
