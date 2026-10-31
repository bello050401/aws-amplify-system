const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {build}=require('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function moduleFrom(file,requirePort){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,require:requirePort,console:{...console,warn:()=>{}},Map,Set,Date});return m.exports;}
(async()=>{
 const cache=moduleFrom('lib/inventory/masterCache.ts',id=>{assert.equal(id,'server-only');return {}});
 const pages=moduleFrom('lib/amplify/listAll.ts',id=>{assert.equal(id,'server-only');return {}});
 let calls=0,fail=false;
 const ports={'server-only':{},'@/lib/amplify/requestCache':{requestCache:fn=>fn},'./masterCache':cache,'@/lib/amplify/listAll':pages,'@/lib/amplify/dataClient':{inventoryAuthMode:{authMode:'userPool'},serverDataClient:{models:{UnitMaster:{list:async options=>{calls++;assert.equal(options.authMode,'userPool');assert.equal(options.limit,1000);if(fail)return {data:[],errors:[{message:'unavailable'}]};return options.nextToken?{data:[{name:'脚',sortOrder:1}],nextToken:null}:{data:[{name:'台',sortOrder:2}],nextToken:'second-page'};}}}}}};
 const queries=moduleFrom('lib/inventory/queries.ts',id=>ports[id]||{});
 const first=await queries.listUnits();assert.deepEqual(Array.from(first),['脚','台']);assert.equal(calls,2);
 first.push('must-not-leak');assert.deepEqual(Array.from(await queries.listUnits()),['脚','台']);assert.equal(calls,2);
 cache.invalidateMasterCache();fail=true;assert.equal((await queries.listUnits()).length,0);const failedCalls=calls;fail=false;assert.equal((await queries.listUnits()).length,2);assert.equal(calls,failedCalls+2);
 const bundle=await build({entryPoints:['components/sales/SaleRegistrationForm.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom','react-dom/server']});
 const form={exports:{}};vm.runInNewContext(bundle.outputFiles[0].text,{module:form,exports:form.exports,require,console,Date});
 const props={item:{id:'test',name:'chair',quantity:5,updatedAt:'2026-11-01T00:00:00Z',salePrice:12345},save:async()=>{throw Error('no writes')},onComplete:()=>{},onCancel:()=>{}};
 const candidate={id:'test',source:'DIRECT',channel:'DIRECT',quantity:1,unitPrice:null,name:'chair',orderId:'',saleDate:'2026-11-01',warnings:[]};
 const price=extra=>{const html=renderToStaticMarkup(React.createElement(form.exports.SaleRegistrationForm,{...props,...extra}));return html.match(/aria-label="販売価格"[^>]*value="([^"]*)"/)[1];};
 assert.equal(price({candidate}),'12345');assert.equal(price({candidate:{...candidate,unitPrice:10000}}),'10000');
 assert.equal(price({candidate:{...candidate,source:'GMAIL',channel:'MERCARI'}}),'');assert.equal(price({}),'12345');
 const overflow=renderToStaticMarkup(React.createElement(form.exports.SaleRegistrationForm,{...props,item:{...props.item,quantity:2},candidate:{...candidate,channel:'YAHOO',source:'GMAIL',identifierType:'AUCTION',orderId:'r1240092475',quantity:3,unitPrice:42800}}));
 assert.match(overflow,/数量超過/);assert.doesNotMatch(overflow,/<dd>-1/);
 assert.match(overflow,/aria-label="販売手数料"[^>]*value="4279\.67"/);
 assert.match(overflow,/自動計算の端数は、売却分の合計で調整/);
 // The UI formatting must not alter the precise allocated fee used for saving.
 const source=fs.readFileSync('components/sales/SaleRegistrationForm.tsx','utf8');
 assert.match(source,/unitCommission:fee\.trim\(\)\?Number\(fee\):null/);
 console.log('PASS: unit pagination/cache/copy/invalidation/error retry; direct and marketplace initial price rendered correctly; no save or external calls.');
})().catch(e=>{console.error(e);process.exitCode=1});
