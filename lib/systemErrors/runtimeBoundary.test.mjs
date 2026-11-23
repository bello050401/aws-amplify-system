import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {transformSync} from 'esbuild';

const plain=value=>JSON.parse(JSON.stringify(value));
function load(name,ports,env={},build={}){
 const loadedModule={exports:{}},define=Object.fromEntries(Object.entries(build).map(([key,value])=>['process.env.'+key,JSON.stringify(value)]));
 const source=fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'),code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022',define}).code;
 vm.runInNewContext(code,{module:loadedModule,exports:loadedModule.exports,process:{env},require:name=>{assert.ok(Object.hasOwn(ports,name),'Unexpected import: '+name);return ports[name];}});
 return loadedModule.exports;
}
const contract=load('contract.ts',{}),queue=load('queue.ts',{'node:crypto':crypto,'@aws-sdk/client-dynamodb':{},'@aws-sdk/lib-dynamodb':{},'./contract':contract,'./cause':{}});
function reporter(env,build={}){
 const configs=[],writes=[];let broken=false;
 class Queue {constructor(config){configs.push(plain(config));}async enqueue(signal,owner){if(broken)throw Error('private transport detail');writes.push({signal:plain(signal),owner});return {accepted:true};}}
 return {configs,writes,setBroken:()=>{broken=true;},server:load('server.ts',{'server-only':{},'./queue':{SystemErrorQueue:Queue,errorQueueConfig:queue.errorQueueConfig},'./contract':contract},env,build)};
}
const names=['BELLO_SYSTEM_ERRORS_ENABLED','BELLO_SYSTEM_ERRORS_TABLE','BELLO_SYSTEM_ERRORS_RELEASE','BELLO_SYSTEM_ERRORS_REGION','AWS_REGION','BELLO_UNRELATED_SECRET'];
async function webBuild(t,generated,env={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bello-system-error-build-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('bello-system-error-build-'));fs.rmSync(dir,{recursive:true,force:true});});
 fs.copyFileSync(new URL('../../next.config.mjs',import.meta.url),path.join(dir,'next.config.mjs'));fs.writeFileSync(path.join(dir,'amplify_outputs.json'),JSON.stringify(generated));
 const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));for(const name of names){if(env[name]===undefined)delete process.env[name];else process.env[name]=env[name];}
 try{return (await import(pathToFileURL(path.join(dir,'next.config.mjs')).href)).default.env;}
 finally{for(const [name,value]of Object.entries(before)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
}
const generated={auth:{api_key:'synthetic-private-key'},custom:{systemErrors:{tableName:'SyntheticErrors',region:'us-west-2',release:'a'.repeat(40)},inventoryEdits:{table:'Jobs',inventoryTable:'History'}}};

test('shared server import is backend-neutral and unconfigured workers stay disabled',async()=>{
 const r=reporter({});assert.equal(r.server.getSystemErrorQueue(),null);assert.equal(await r.server.reportServerSystemError({code:'FEATURE_OPERATION_FAILED',surface:'server',component:'inventory-search',operation:'search'}),false);assert.deepEqual(r.configs,[]);assert.deepEqual(r.writes,[]);
});
test('actual Next build config maps only nonsecret generated defaults and preserves existing mapping',async t=>{
 const build=await webBuild(t,generated,{BELLO_UNRELATED_SECRET:'synthetic-private-key'});
 assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_ENABLED,'1');assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_TABLE,'SyntheticErrors');assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_REGION,'us-west-2');assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_RELEASE,'a'.repeat(40));assert.equal(build.INVENTORY_EDIT_JOBS_TABLE,'Jobs');assert.equal(build.INVENTORY_HISTORY_TABLE,'History');assert.ok(!JSON.stringify(build).includes('synthetic-private-key'));
 const r=reporter({},Object.fromEntries(Object.entries(build).filter(([key])=>key.startsWith('BELLO_SYSTEM_ERRORS_BUILD_'))));r.server.getSystemErrorQueue();assert.deepEqual(r.configs,[{table:'SyntheticErrors',region:'us-west-2',release:'a'.repeat(40)}]);
});
test('runtime explicit disable and overrides survive compile-time replacement of build defaults',async t=>{
 const build=await webBuild(t,generated),defaults=Object.fromEntries(Object.entries(build).filter(([key])=>key.startsWith('BELLO_SYSTEM_ERRORS_BUILD_')));
 const off=reporter({BELLO_SYSTEM_ERRORS_ENABLED:'0'},defaults);assert.equal(off.server.getSystemErrorQueue(),null);assert.deepEqual(off.configs,[]);
 const r=reporter({BELLO_SYSTEM_ERRORS_ENABLED:'1',BELLO_SYSTEM_ERRORS_TABLE:'RuntimeErrors',BELLO_SYSTEM_ERRORS_RELEASE:'b'.repeat(40),BELLO_SYSTEM_ERRORS_REGION:'eu-west-1',AWS_REGION:'ap-southeast-2'},defaults);r.server.getSystemErrorQueue();assert.deepEqual(r.configs,[{table:'RuntimeErrors',region:'ap-southeast-2',release:'b'.repeat(40)}]);
 const region=reporter({BELLO_SYSTEM_ERRORS_REGION:'eu-west-1'},defaults);region.server.getSystemErrorQueue();assert.equal(region.configs[0].region,'eu-west-1');
});
test('explicit build disable, build env precedence and absent generated metadata are preserved',async t=>{
 const build=await webBuild(t,generated,{BELLO_SYSTEM_ERRORS_ENABLED:'0',BELLO_SYSTEM_ERRORS_TABLE:'BuildErrors',BELLO_SYSTEM_ERRORS_RELEASE:'c'.repeat(40),BELLO_SYSTEM_ERRORS_REGION:'eu-west-1',AWS_REGION:'ap-northeast-1'});assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_ENABLED,'0');assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_TABLE,'BuildErrors');assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_RELEASE,'c'.repeat(40));assert.equal(build.BELLO_SYSTEM_ERRORS_BUILD_REGION,'ap-northeast-1');assert.equal(reporter({},Object.fromEntries(Object.entries(build).filter(([key])=>key.startsWith('BELLO_SYSTEM_ERRORS_BUILD_')))).server.getSystemErrorQueue(),null);
 const missing=await webBuild(t,{});assert.equal(missing.BELLO_SYSTEM_ERRORS_BUILD_ENABLED,'0');assert.equal(missing.BELLO_SYSTEM_ERRORS_BUILD_TABLE,'');
});
test('runtime queue reporter keeps fixed allowlist and transport failures remain best effort',async()=>{
 const r=reporter({BELLO_SYSTEM_ERRORS_ENABLED:'1',BELLO_SYSTEM_ERRORS_TABLE:'RuntimeErrors',BELLO_SYSTEM_ERRORS_RELEASE:'d'.repeat(40)}),signal={code:'FEATURE_OPERATION_FAILED',surface:'server',component:'inventory-search',operation:'search',check:'operation-failed'};
 assert.equal(await r.server.reportServerSystemError({...signal,message:'private customer value',url:'https://private.invalid'}),true);assert.deepEqual(r.writes,[{signal,owner:'server-runtime'}]);r.setBroken();assert.equal(await r.server.reportServerSystemError(signal),false);assert.ok(!JSON.stringify(r.writes).includes('private'));
 const invalid=reporter({BELLO_SYSTEM_ERRORS_ENABLED:'1',BELLO_SYSTEM_ERRORS_TABLE:'not a table',BELLO_SYSTEM_ERRORS_RELEASE:'d'.repeat(40)});assert.equal(invalid.server.getSystemErrorQueue(),null);
});
