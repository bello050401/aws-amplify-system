import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {StockSplitError} from '../lib/inventory/stockSplitInput.ts';
const id='11111111-1111-4111-8111-111111111111';
function load(file,stubs){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>{if(!(n in stubs))throw Error('Unstubbed '+n);return stubs[n];},process:{env:{BELLO_MOBILE_WRITES_ENABLED:'true'}},Buffer,URL,Error,Uint8Array,console});return exports;}
function fixture(role,verifiedRole=role){let mutations=0;const stubs={
 'next/server':{NextResponse:{json:(data,options)=>({data,...options})}},'next/cache':{revalidatePath(){}},
 '@/lib/mobile/session':{getMobileSession:async()=>({ok:true,owner:id,role,features:{sales:true,ecListing:true}})},
 '@/lib/inventory/mutationSession':{inventoryMutationSession:async()=>verifiedRole?{owner:id,role:verifiedRole}:null},
 '@/lib/inventory/categoryPersistence':{inventoryDdb:{},inventoryTable:n=>n},
 '@/lib/inventory/stockSplitCore':{createStockSplitService:()=>async()=>{mutations++;return {sourceId:id,splitId:id};}},
 '@/lib/inventory/stockSplitInput':{StockSplitError},
 '@/lib/inventory/soldOutPhotos':{copySoldOutPhotos(){},discardSoldOutPhotos(){}},
 '@/lib/amplify/dataClient':{serverDataClient:{},inventoryAuthMode:{}},
 '@/lib/inventory/inventoryPage':{clearInventoryCountCache(){}},
 '@/app/actions/soldOut':{registerSoldOut:async()=>{mutations++;return {ok:true};}},
 };return {stubs,mutations:()=>mutations};}
function request(extra={}){return new Request('http://localhost/api/mobile/inventory/'+id+'/split',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-Bello-Mobile':'1',...extra},body:JSON.stringify({inventoryId:id,mutationId:id})});}
test('スタッフ・閲覧者の売却APIを拒否し、管理者だけ到達できる',async()=>{for(const role of ['EDITOR','VIEWER','ADMIN']){const f=fixture(role),route=load('app/api/mobile/inventory/[id]/sold-out/route.ts',f.stubs),r=await route.POST(request(),{params:{id}});assert.equal(r.status,role==='ADMIN'?200:403);assert.equal(f.mutations(),role==='ADMIN'?1:0);}});
test('在庫分けは管理者とスタッフに許可し、閲覧者・署名検証失敗を拒否',async()=>{for(const [role,verified,allowed] of [['ADMIN','ADMIN',true],['EDITOR','EDITOR',true],['VIEWER',null,false],['ADMIN',null,false]]){const f=fixture(role,verified),route=load('app/api/mobile/inventory/[id]/split/route.ts',f.stubs),r=await route.POST(request(),{params:{id}});assert.equal(r.status??200,allowed?200:403);assert.equal(f.mutations(),allowed?1:0);}});
test('別サイトからの分割と別在庫ID指定を拒否',async()=>{const f=fixture('EDITOR'),route=load('app/api/mobile/inventory/[id]/split/route.ts',f.stubs);assert.equal((await route.POST(request({Origin:'https://untrusted.invalid'}),{params:{id}})).status,403);assert.equal((await route.POST(request(),{params:{id:'other'}})).status,422);assert.equal(f.mutations(),0);});
