import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {parseYahooListingResult} from './listingResult.ts';
const inventoryId='57b4b2b5-d6ad-435a-b303-5d412405a44c';
const row={inventoryId,auctionId:'f1248612637',title:'Chair',priceYen:99999,quantity:1,remoteStatus:'open',bids:0,checkedAt:'2026-10-16T14:50:30Z',revision:1};
test('remote result parser returns only validated public metadata',()=>{
 assert.deepEqual(parseYahooListingResult({...row,secret:'private'}),row);
 for(const change of [{auctionId:'https://evil.example'},{remoteStatus:'saved'},{priceYen:'99999'},{checkedAt:'bad'},{revision:0}])assert.equal(parseYahooListingResult({...row,...change}),null);
});
test('result refresh uses stored ID, checks role and content, and conditions persistence on revision',async()=>{
 for(const mode of ['viewer','changed','success','lost']){
  let reads=0,remoteReads=0,writes=0,stored={...row};
  const stubs={
   '@/lib/amplify/requireInventoryUser':{canEditInventory:r=>r==='EDITOR',getInventoryRole:async()=>mode==='viewer'?'VIEWER':'EDITOR'},
   '@/lib/listing/yahooAuction/preparation':{yahooInventoryIdValid:v=>v===inventoryId},
   '@/lib/listing/yahooAuction/listingResult':{parseYahooListingResult},
   '@/lib/listing/yahooAuction/webHttpRuntime':{readYahooRuntimeSession:async()=>({ok:true,session:{inspectListing:async id=>{
    remoteReads++;assert.equal(id,row.auctionId);return{ok:true,value:{title:mode==='changed'?'Different':'Chair',priceYen:99999,quantity:1,status:'cancelled',bids:0,checkedAt:'2026-10-16T15:00:00Z'}};
   }}})},
   '@/lib/amplify/dataClient':{inventoryAuthMode:{},serverDataClient:{models:{YahooAuctionListing:{get:async()=>{reads++;return{data:stored}}}},graphql:async args=>{
    writes++;assert.equal(args.variables.condition.revision.eq,1);assert.equal(args.variables.condition.auctionId.eq,row.auctionId);
    stored=args.variables.input;if(mode==='lost')throw Error('private');return{data:{updateYahooAuctionListing:stored}};
   }}},
  };
  const exports={};const code=ts.transpileModule(fs.readFileSync(new URL('../../../app/actions/yahooAuctionResult.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>{if(!stubs[n])throw Error(n);return stubs[n]}});
  const r=await exports.refreshYahooListingResultAction(inventoryId);
  assert.equal(r.ok,['success','lost'].includes(mode));assert.equal(remoteReads,mode==='viewer'?0:1);assert.equal(writes,['success','lost'].includes(mode)?1:0);
  if(r.ok){assert.equal(r.listing.remoteStatus,'cancelled');assert.equal(r.listing.revision,2);}
  if(mode==='viewer')assert.equal(reads,0);
 }
});
