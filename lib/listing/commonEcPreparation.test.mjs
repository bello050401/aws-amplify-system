import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import * as settings from './commonSettings.ts';import * as preparation from './yahooAuction/preparation.ts';import * as quantity from './quantity.ts';
function fixture({role='ADMIN',stock=5}={}){
 const draft={id:'draft',inventoryId:'id',updatedAt:'2026-10-22T00:00:00Z',title:'共通の商品名',description:'商品の説明',price:92000,quantity:3,commonCategoryId:'dining-chair',channelPrices:{MERCARI_SHOPS:100000,YAHOO:92000,BASE:95000,INDEPENDENT:92000},shippingMethod:'KAZAI',condition:'NO_NOTABLE_DAMAGE',images:[{storageKey:'inventory/image.jpg',sortOrder:0}]};
 // Resolve an actual common master rather than a fake channel mapping.
 const match=settings.COMMON_CATEGORIES?.[0]; if(match)draft.commonCategoryId=match.id;
 let yahoo=null,mercari=null,reservations=0;
 const stubs={
 '@/lib/amplify/requireInventoryUser':{getInventoryRole:async()=>role,canEditInventory:r=>['ADMIN','EDITOR'].includes(r)},
 '@/lib/listing/service':{getListingDraftForInventory:async()=>draft},
 '@/lib/inventory/queries':{getInventoryDetail:async()=>({quantity:stock})},
 '@/lib/listing/commonSettings':settings,'@/lib/listing/quantity':quantity,'@/lib/listing/yahooAuction/preparation':preparation,
 './yahooAuctionPreparation':{getYahooAuctionPreparationAction:async()=>({ok:true,context:{draft,saved:null,availableQuantity:stock,canPrepare:role!=='VIEWER'}}),saveYahooAuctionPreparationAction:async(id,input)=>{yahoo=input;return {ok:true,saved:{revision:1,payload:{input}}}}},
 './mercariWebHttpDraftJob':{prepareMercariWebHttpDraftJobAction:async(id,input)=>{mercari=input;return {ok:true,pack:input}},reserveMercariWebHttpDraftJobAction:async()=>{reservations++;return {ok:true}}}
 };
 const source=fs.readFileSync(new URL('../../app/actions/commonEcPreparation.ts',import.meta.url),'utf8');const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{if(!stubs[name])throw Error(name);return stubs[name]},Date,JSON,Error});
 return {api:exports,draft,read:()=>({yahoo,mercari,reservations})};
}
test('common-only save can prepare Yahoo and Mercari with shared quantity/category/prices',async()=>{const f=fixture();const category=settings.commonCategory(f.draft.commonCategoryId);assert.ok(category);assert.equal((await f.api.ensureYahooCommonPreparationAction('id')).ok,true);assert.equal((await f.api.prepareMercariFromCommonAction('id')).ok,true);const s=f.read();assert.equal(s.yahoo.quantity,3);assert.equal(s.mercari.quantity,3);assert.equal(s.yahoo.categoryId,category.yahoo.id);assert.equal(s.mercari.categoryId,category.mercari.id);assert.equal(s.yahoo.priceYen,92000);assert.equal(s.mercari.priceYen,100000);assert.equal(s.mercari.shippingMethod,'METHOD_TYPE_UNDECIDED');});
test('read-only role and excessive quantity stop before preparation is saved',async()=>{const f=fixture({role:'VIEWER'});assert.equal((await f.api.prepareMercariFromCommonAction('id')).ok,false);assert.equal(f.read().reservations,0);assert.equal((await fixture({stock:2}).api.ensureYahooCommonPreparationAction('id')).ok,false);});
