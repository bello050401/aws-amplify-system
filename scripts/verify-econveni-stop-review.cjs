const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {build} = require('esbuild');

(async()=>{
  const id='inventory-stop-review';let current,values,listingId,sends=0;
  const reset=()=>{current={inventoryId:id,revision:1,save:{state:'SUCCEEDED',productId:'123',fingerprint:'old-draft',expected:{fields:{products_name:'【在庫5】椅子',products_price:'10000',products_quantity:'5'},imageHashes:[]}},channels:{YAHOO:{state:'SUCCEEDED',remoteStatus:'ACTIVE',listingId:'a123456'},MERCARI_SHOPS:{state:'NOT_STARTED'}}};values={products_name:'【在庫3】椅子',products_price:'10000',products_quantity:'3'};listingId='a123456';sends=0;};
  class HttpError extends Error{};class WorkflowError extends Error{constructor(code){super(code);this.code=code;}}
  class Session{
    async readInventory(){return {productId:'123',channels:{YAHOO:{state:'ACTIVE',listingId}}};}
    async saleProductFields(){return {values:{...values}};}
    async publicationPreview(r){assert.equal(r.productId,'123');assert.equal(r.title,values.products_name);assert.equal(r.price,Number(values.products_price));return r;}
  }
  const store={read:async()=>current,commit:async(_,next)=>current={...next,revision:current.revision+1}};
  const stubs={
    'server-only':{},'node:crypto':require('node:crypto'),'sharp':{},
    '../service':{},'@/lib/inventory/queries':{},'@/app/actions/yahooAuctionPreparation':{},'../mercari/csv/buildExportRows':{},
    './httpSession':{EconveniHttpSession:Session,EconveniHttpError:HttpError},
    './credentials':{econveniCredentialStore:{}},'./runtimeStore':{econveniStore:()=>store},
    './accountWorkflow':{withEconveniAccount:async(_s,_h,_credentials,fn)=>fn()},
    './workflowStore':{EconveniWorkflowError:WorkflowError},'./saveWorkflow':{},
    './mapping':{EconveniPreparationError:class extends Error{}},'./manualWriteGuard':{manualWriteRestriction:async()=>null},
    './commandWorkflow':{runEconveniCommand:async(_store,session,input)=>{
      assert.equal(input.operation,'STOP');await session.publicationPreview({...input,productId:'123'});sends++;
      return {...current,channels:{...current.channels,YAHOO:{state:'SUCCEEDED'}}};
    }},
  };
  const result=await build({entryPoints:[path.resolve(__dirname,'../lib/listing/econveni/service.ts')],platform:'node',format:'cjs',write:false,bundle:false});
  const module={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:n=>{if(!(n in stubs))throw Error('Unexpected dependency: '+n);return stubs[n];},Date,console,Error});
  const run=module.exports.econveniOperation;
  reset();let review=await run(id,'YAHOO','STOP','actor');assert.equal(review.status,'READY');assert.equal(review.title,'【在庫3】椅子');assert.equal(review.quantity,3);assert.equal(sends,0);
  assert.equal((await run(id,'YAHOO','STOP','actor',review.token)).status,'DONE');assert.equal(sends,1);
  reset();review=await run(id,'YAHOO','STOP','actor');values.products_name='別の商品に変更';assert.equal((await run(id,'YAHOO','STOP','actor',review.token)).status,'BLOCKED');assert.equal(sends,0);
  reset();listingId='other123';assert.equal((await run(id,'YAHOO','STOP','actor')).status,'BLOCKED');assert.equal(sends,0);
  reset();review=await run(id,'YAHOO','STOP','actor');assert.equal((await run(id,'YAHOO','STOP','other-actor',review.token)).status,'BLOCKED');assert.equal(sends,0);
  console.log('PASS 4: sale-adjusted title/quantity stop; changed title, listing ID and actor rejected without sending');
})().catch(e=>{console.error(e);process.exitCode=1;});
