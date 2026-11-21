const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const allowed=['./app/api/sale-candidates/desktop-jobs/route','@/lib/listing/econveni/saleAdjustment','@/lib/saleCandidates/desktopBoundary','@/lib/listing/econveni/saleBindingError','./saleBindingError','./desktopJobModel','@/lib/saleCandidates/desktopJobModel','./accountWorkflow','@/lib/listing/econveni/manualSyncModel','./manualSyncModel','../listing/econveni/manualSyncModel','@/lib/listing/mercariBridge/postGuard'];
 const built=await build({stdin:{contents:"export {GET,POST} from './app/api/sale-candidates/desktop-jobs/route';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'actual-binding-boundary',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'||allowed.includes(a.path)?undefined:{path:a.path,external:true});}}]});
 const inventoryId='10000000-0000-4000-a000-000000000001',jobId='a'.repeat(64),oldYahoo='p1236475246',newYahoo='c1249879020',mercari='same-mercari-id';
 let failure,admin,jobWrites,linkWrites,cacheWrites,reports,stops,loginCount,reads,purpose;
 const reset=()=>{failure='listing';admin=true;jobWrites=0;linkWrites=0;cacheWrites=0;reports=0;stops=0;loginCount=0;reads=0;purpose='VERIFY_SALE';};
 const channels=()=>({BASE:{state:'ACTIVE',listingId:'base-same'},YAHOO:{state:'ACTIVE',listingId:newYahoo},MERCARI_SHOPS:{state:'ACTIVE',listingId:mercari}});
 const product=()=>({productId:'123',title:'Synthetic chair',price:1000,quantity:1,inventoryMarker:failure==='marker'?'foreign-stock':inventoryId,channels:channels()});
 const data=()=>({snapshot:{products:[product()]},links:[{inventoryId,productId:'123',inventoryName:'Synthetic chair',remoteTitle:'Synthetic chair',revision:1,baseline:{...channels(),YAHOO:{state:'ACTIVE',listingId:oldYahoo}}}]});
 const item=()=>{reads++;if(failure==='storage')throw Error('PRIVATE_STORAGE_DETAIL');if(failure==='lookalike')throw Object.assign(Error('出品IDが変わっています。'),{name:'SaleBindingError',code:'SALE_BINDING_LISTING_CHANGED'});return{id:inventoryId,name:'Synthetic chair',updatedAt:'v1'};};
 const job=()=>({id:jobId,candidateId:'c'.repeat(64),purpose,inventoryId,inventoryVersion:'v1',externalId:mercari,orderId:'order',orderLineId:'1',imageKeys:['photo'],state:'CLAIMED',actor:'admin',lease:'lease',targetQuantity:0});
 class EconveniHttpError extends Error{constructor(code){super(code);this.code=code;}}class EconveniWorkflowError extends Error{constructor(code){super(code);this.code=code;}}
 const account={acquire:async()=>{if(failure==='busy')throw new EconveniWorkflowError('BUSY_OR_STOPPED');},release:async()=>{},stop:async()=>{stops++;},read:async()=>null};
 const db={send:async command=>{if(command.constructor.name==='GetCommand')return{};if(command.constructor.name==='PutCommand'){cacheWrites++;return{};}throw Error('Unexpected write');}};
 const http={EconveniHttpError,EconveniHttpSession:class{async login(){loginCount++;if(failure==='auth')throw new EconveniHttpError('AUTH_REQUIRED');}dispose(){}async readExternalProduct(){return product();}}};
 const runtime={econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'ec',econveniStore:()=>account};
 const inventory={getInventoryRaw:async()=>item(),inventoryTable:n=>n};
 const store={candidateConfig:()=>({tableName:'candidates'}),candidateBuildRelease:()=> '6c5b808e',candidateStore:()=>({get:async()=>({state:purpose==='STOCK'?'DONE':'PENDING',channel:'MERCARI',externalListingId:mercari,orderId:'order',orderLineId:'1',result:{sourceId:inventoryId,remainingQuantity:0}})})};
 const mods={
  'server-only':{},'node:crypto':require('node:crypto'),'@aws-sdk/lib-dynamodb':require('@aws-sdk/lib-dynamodb'),
  'next/server':{NextResponse:{json:(body,options)=>new Response(JSON.stringify(body),options)}},
  '@/lib/inventory/mutationSession':{inventoryMutationSession:async()=>admin?{role:'ADMIN',owner:'admin'}:null},
  '@/lib/inventory/categoryPersistence':inventory,'./runtimeStore':runtime,'@/lib/listing/econveni/runtimeStore':runtime,
  './httpSession':http,'@/lib/listing/econveni/httpSession':http,'@/lib/listing/econveni/workflowStore':{EconveniWorkflowError},
  './credentials':{econveniCredentialStore:{credentials:async()=>({loginId:'synthetic',password:'synthetic'})}},
  './manualSync':{readManualSync:async()=>data()},'@/lib/listing/econveni/manualSync':{readManualSync:async()=>data()},
  '../service':{getChannelListing:async()=>null},'../base/manualLifecycle':{},'../base/adapter':{},'./failure':{},'./saleAdjustmentCore':{adjustmentFingerprint:JSON.stringify},'./manualStop':{manualLinkedStop:async()=>{linkWrites++;throw Error('No STOP/link write authorized');}},
  '@/lib/inventory/stockCountTitle':{},'@/lib/saleCandidates/yahooSettlementContinuationServer':{},
  '@/lib/saleCandidates/desktopImagePreviews':{signDesktopImage:async()=>'/synthetic.jpg'},
  '@/lib/saleCandidates/desktopJobs':{desktopJobs:{get:async()=>job(),claim:async()=>{jobWrites++;throw Error('Must not claim on conflict');},startWrite:async()=>{jobWrites++;throw Error('Must not start on conflict');},finish:async()=>{jobWrites++;throw Error('Must not finish on conflict');}},desktopImageKeys:async()=>['photo'],refreshDesktopJobAfterYahooPayment:async j=>j},
  '@/lib/saleCandidates/store':store,'@/lib/invoicing/gateway':{NO_STORE:{'cache-control':'no-store'},bodyLimited:r=>r.json()},
  '@/lib/saleCandidates/saleBinding':{ensureAutomaticSaleBinding:async()=>{linkWrites++;throw Error('No automatic baseline overwrite');}},
  '@/lib/saleCandidates/errorReporting':{reportSaleAutomationFailure:async()=>{reports++;return true;}},
 };
 const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:name=>{if(!(name in mods))throw Error('Unexpected dependency '+name);return mods[name];},Date,Map,Set,URL,Request,Response,console,process:{env:{}}});
 const get=()=>module.exports.GET(new Request('http://localhost/api/sale-candidates/desktop-jobs?inventoryId='+inventoryId));
 const post=action=>module.exports.POST(new Request('http://localhost/api/sale-candidates/desktop-jobs',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json','x-bello-sale-desktop':'1'},body:JSON.stringify({id:jobId,action,lease:'lease',evidence:{}})}));
 const noWrites=()=>{assert.equal(jobWrites,0);assert.equal(linkWrites,0);assert.equal(cacheWrites,0);};
 reset();let response=await get(),body=await response.json();assert.equal(response.status,409);assert.equal(body.code,'SALE_BINDING_LISTING_CHANGED');assert.equal(body.channel,'YAHOO');assert.equal(body.action.href,'/inventory/listings');assert.match(body.error,/写真・商品名・出品番号/);assert(!JSON.stringify(body).includes(oldYahoo));assert(!JSON.stringify(body).includes(newYahoo));assert.equal(reports,0);noWrites();
 for(const action of ['claim','start-write']){reset();if(action==='start-write')purpose='STOCK';response=await post(action);body=await response.json();assert.equal(response.status,409);assert.equal(body.channel,'YAHOO');assert.equal(body.reported,false);assert.equal(reports,0);noWrites();}
 reset();failure='marker';response=await get();body=await response.json();assert.equal(response.status,409);assert.equal(body.code,'SALE_BINDING_INVENTORY_CHANGED');noWrites();
 for(const reason of ['storage','lookalike']){reset();failure=reason;response=await get();body=await response.json();assert.equal(response.status,500);assert.equal(body.code,'DESKTOP_STORAGE_FAILED');assert(!JSON.stringify(body).includes('PRIVATE_STORAGE_DETAIL'));noWrites();}
 reset();failure='storage';response=await post('claim');body=await response.json();assert.equal(response.status,500);assert.equal(reports,1);assert.equal(body.reported,true);noWrites();
 for(const reason of ['auth','busy']){reset();failure=reason;response=await get();body=await response.json();assert.equal(response.status,409);assert.equal(reports,0);noWrites();if(reason==='auth'){assert.equal(stops,1);assert.equal(body.action.href,'/inventory/settings?tab=econveni');}}
 reset();admin=false;response=await get();assert.equal(response.status,403);assert.equal(reads,0);assert.equal(loginCount,0);noWrites();
 assert(fs.existsSync('app/inventory/(protected)/listings/page.tsx'));assert(fs.readFileSync('app/inventory/(protected)/listings/ListingsOverviewTable.tsx','utf8').includes('eコンビニ連携'));
 console.log('PASS: real reviewSaleBinding conflict reaches GET/POST409 with safe channel/action, no job/link/receipt/repair write; storage/lookalike500, typed auth/account holds, existing linkage URL and ADMIN gate preserved.');
})().catch(error=>{console.error(error);process.exitCode=1;});
