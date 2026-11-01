const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild');
async function load(file,ports){const b=await build({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});const m={exports:{}};vm.runInNewContext(b.outputFiles[0].text,{module:m,exports:m.exports,require:k=>{assert(k in ports,'unexpected dependency '+k);return ports[k]},Map,Set,Date});return m.exports;}
(async()=>{
 let role='ADMIN',calls=[],release,blocked=false,fail='';
 const read=async(key,value)=>{calls.push(key);if(key===fail)throw Error('read failed');if(key==='legacy'&&blocked)await new Promise(r=>release=r);return value;};
 const ports={
 '@/lib/amplify/requireInventoryUser':{getInventoryRole:async()=>role},
 '@/lib/amplify/dataClient':{inventoryAuthMode:{authMode:'userPool'},serverDataClient:{models:{
 ChannelListing:{list:()=>read('legacy',{data:[{inventoryId:'i',channel:'BASE',status:'PAUSED',updatedAt:'v'}]})},
 YahooAuctionListing:{list:()=>read('yahoo',{data:[]})},MercariBridgeHttpProductLink:{list:()=>read('mercari',{data:[]})},ListingDraft:{list:()=>read('draft',{data:[]})}}}},
 '@/lib/listing/econveni/runtimeStore':{readEconveniCatalog:()=>read('workflow',[])},
 '@/lib/listing/econveni/manualSync':{readManualSync:()=>read('manual',{links:[],snapshot:null})},
 '@/lib/listing/econveni/manualSyncModel':{overlayManualStatuses:()=>{}},
 '@/lib/listing/econveni/manualStop':{overlayManualStops:()=>read('stop',null)},
 '@/lib/listing/econveni/overviewCatalog':{remoteOverview:()=>read('remote',{products:[]}),soldListingReferences:()=>read('sold',[])},
 };
 const {getEcListingCatalogAction:catalog}=await load('app/actions/ecListingCatalog.ts',ports);
 role=null;await catalog();assert.equal(calls.length,0);
 role='ADMIN';blocked=true;const pending=catalog();await new Promise(r=>setImmediate(r));
 for(const key of ['legacy','yahoo','mercari','draft','workflow','manual','sold'])assert(calls.includes(key),'independent read not started: '+key);
 assert(!calls.includes('remote'),'dependent read cannot start before its inputs');release();const result=await pending;assert.equal(result.errors.length,0);assert.equal(result.channels.BASE.i.state,'STOPPED');assert.equal(result.econveni.products.length,0);
 blocked=false;for(const failed of ['workflow','manual','sold','legacy']){fail=failed;calls=[];const r=await catalog();assert(r.errors.length,'failed read must remain visible: '+failed);if(failed==='workflow')assert.equal(r.channels.YAHOO,undefined);}
 fail='';role='EDITOR';calls=[];await catalog();assert(!calls.includes('mercari'));
 let rowRelease,catStarted=false;const data=await load('app/inventory/(protected)/listings/ListingsOverviewData.tsx',{
 '@/lib/listing/service':{listListingsOverviewSafe:()=>new Promise(r=>rowRelease=r)},
 '@/app/actions/ecListingCatalog':{getEcListingCatalogAction:async()=>{catStarted=true;return result;}},
 './ListingsOverviewTable':{ListingsOverviewTable:()=>{}},'react/jsx-runtime':{jsx:(_type,props)=>props},
 });
 const rendering=data.ListingsOverviewData({canEdit:false});assert(catStarted);rowRelease({ok:true,rows:[]});const props=await rendering;assert.equal(props.initialCatalog,result);assert.equal(props.canEdit,false);
 console.log('PASS: EC reads start together after auth; dependent inputs, role restrictions, partial errors and server initial catalog preserved.');
})().catch(e=>{console.error(e);process.exitCode=1;});
