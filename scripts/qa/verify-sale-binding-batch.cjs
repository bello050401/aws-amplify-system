const {build}=require('esbuild'),vm=require('vm'),assert=require('assert/strict');
(async()=>{
let log=[],cacheRace=false,remoteId='b1',authFail=false,previewAuth=false,stored=[];
const external={productId:'123',title:'椅子',quantity:1,price:10000,inventoryMarker:null,channels:{BASE:{listingId:'b1',state:'ACTIVE'},MERCARI_SHOPS:{listingId:'m1',state:'ACTIVE'},YAHOO:{listingId:'y1',state:'ACTIVE'}}};
const link={productId:'123',inventoryId:'inv',revision:1,baseline:external.channels};
const make=k=>class{constructor(input){this.input=input;this.kind=k;}};
const db={send:async c=>{const key=c.input.Key?.pk;if(c.kind==='GetCommand'){if(key==='ECONVENI#MANUAL_LINK#inv')return{Item:link};if(key==='ECONVENI#OBSERVED_CATALOG')return{Item:{version:'v1',checkedAt:'2026-01-01',products:[external]}};return{};}if(c.kind==='PutCommand'){if(cacheRace)throw Object.assign(Error('race'),{name:'ConditionalCheckFailedException'});log.push('cache');return{};}throw Error('unexpected DB write');}};
class HttpError extends Error{constructor(code){super(code);this.code=code;}}
class Session{async login(){log.push('login');if(authFail)throw new HttpError('AUTH_REQUIRED');}dispose(){log.push('dispose');}async readExternalProduct(){log.push('read');return structuredClone({...external,channels:{...external.channels,BASE:{...external.channels.BASE,listingId:remoteId}}});}async manualStopPreview(){log.push('preview');if(previewAuth)throw new HttpError('ADDITIONAL_AUTH');return{};}async executeCommand(){throw Error('FORBIDDEN external mutation');}}
const store={acquire:async()=>log.push('acquire'),release:async()=>log.push('release'),stop:async c=>log.push('stop:'+c),read:async()=>null,commitManualStop:async(_,n,checks,reserve)=>{assert.equal(reserve,false);assert.equal(checks.length,3);stored.push(n);return n;}};
const mods={
 'server-only':{},'node:crypto':require('crypto'),'@aws-sdk/lib-dynamodb':Object.fromEntries(['GetCommand','PutCommand','ScanCommand','TransactWriteCommand'].map(k=>[k,make(k)])),
 './runtimeStore':{econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'qa',econveniStore:()=>store},
 './httpSession':{EconveniHttpSession:Session,EconveniHttpError:HttpError,econveniCommandCompleted:()=>{throw Error('send');}},
 './credentials':{econveniCredentialStore:{credentials:async()=>({loginId:'fixture',password:'fixture'})}},
 './service':{econveniFailure:e=>{console.error('MOCK ERROR',e);return {status:'BLOCKED',message:e.code||'error'};}},
 '@/lib/inventory/categoryPersistence':{getInventoryRaw:async()=>({id:'inv',name:'椅子',updatedAt:'v1'}),inventoryTable:()=> 'inventory'},
 '@/lib/inventory/stockCountTitle':{},'../service':{getChannelListing:async()=>null},
 '../base/manualLifecycle':{readBaseItem:async id=>({id,visible:true,title:'椅子',quantity:1,price:10000})},
 '../base/adapter':{setManualBaseVisibility:async()=>{throw Error('FORBIDDEN BASE mutation');}},'./saleAdjustmentCore':{adjustmentFingerprint:()=> 'fingerprint'}
};
const loaded={};async function load(p){const b=await build({entryPoints:[p],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});const module={exports:{}};vm.runInNewContext(b.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in mods))throw Error('Unexpected '+k);return mods[k];},Date,Set,Map,console});return module.exports;}
mods['./accountWorkflow']=await load('lib/listing/econveni/accountWorkflow.ts');mods['./manualStopCore']=await load('lib/listing/econveni/manualStopCore.ts');mods['./manualStop']=await load('lib/listing/econveni/manualStop.ts');const {reviewSaleBinding}=await load('lib/listing/econveni/saleAdjustment.ts');
for(const race of [false,true]){log=[];stored=[];cacheRace=race;const r=await reviewSaleBinding('inv','owner',['BASE','MERCARI_SHOPS']);assert.equal(r.remote.productId,'123');assert.equal(r.reviews.BASE.status,'READY');assert.equal(r.reviews.MERCARI_SHOPS.status,'READY');assert.equal(log.filter(x=>x==='login').length,1);assert.equal(log.filter(x=>x==='read').length,1);assert.equal(log.filter(x=>x==='acquire').length,1);assert.equal(stored.length,2);assert(stored.every(x=>x.state==='READY'));console.log('PASS shared read and no external writes; cache race='+race);}
log=[];stored=[];remoteId='wrong';await assert.rejects(()=>reviewSaleBinding('inv','owner',['BASE']),/出品IDが変わ/);assert.equal(stored.length,0);assert(log.includes('release'));remoteId='b1';console.log('PASS changed listing ID blocks preflight');
log=[];authFail=true;await assert.rejects(()=>reviewSaleBinding('inv','owner',['BASE']));assert(log.includes('stop:AUTH_REQUIRED'));assert(!log.includes('read'));authFail=false;console.log('PASS login failure stops queue and releases lease');
log=[];previewAuth=true;await assert.rejects(()=>reviewSaleBinding('inv','owner',['MERCARI_SHOPS']));assert(log.includes('stop:ADDITIONAL_AUTH'));previewAuth=false;console.log('PASS preview authentication failure reaches shared account guard');
await assert.rejects(()=>mods['./manualStop'].manualLinkedStop('inv','BASE','owner','token',{session:new Session(),remote:external}),/PREFLIGHT_ONLY/);console.log('PASS cached observations cannot execute external writes');
})().catch(e=>{console.error(e);process.exitCode=1;});
