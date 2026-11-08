import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInquiryReadWorker} from '../src/inquiryCloudWorker.mjs';
import {loadInquiryConfig} from '../src/inquiryConfig.mjs';
import {openBelloAdminContext} from '../src/belloSession.mjs';
import {openDedicatedLogin,openInquiryReadSession} from '../src/session.mjs';
const job={jobId:'READ#'+'a'.repeat(64),shopId:'shop1',leaseId:'lease1'};
const response=(body,status=200)=>({status:()=>status,ok:()=>status===200,json:async()=>body});
async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'bello-inquiry-worker-'));
 const config={root,origin:'https://bello.example.test',shopId:'shop1',belloProfileDir:join(root,'bello'),profileDir:join(root,'shops'),playwrightModulePath:join(root,'node_modules/playwright/package.json')};
 const calls=[],waits=[],closed=[],statuses=[];let reads=0;
 const controller=new AbortController();
 const ports={openBello:async()=>({request:{post:async(url,opts)=>{
  assert.equal(url,config.origin+'/api/inventory/inquiry-read');assert.equal(opts.maxRedirects,0);const body=JSON.parse(opts.data);calls.push(body);return await ports.respond(body);
 }},close:async()=>closed.push('bello')}),openShops:async()=>({page:{},context:{close:async()=>closed.push('shops')}}),
 read:async()=>{reads++;return {messages:[{body:'PRIVATE_BODY',speaker:'BUYER'}]};},respond:async body=>response({ok:true,job:body.action==='CLAIM'?job:null}),wait:async ms=>{waits.push(ms);controller.abort();}};
 const options={once:true,onStatus:code=>statuses.push(code),signal:controller.signal};
 try{await run({root,config,ports,options,calls,waits,closed,statuses,controller,reads:()=>reads});}
 finally{await rm(root,{recursive:true,force:true});}
}
test('one read, idempotent lost receipt retry, no message content in status and lock removed',()=>fixture(async f=>{
 let complete=0;f.ports.respond=async b=>{if(b.action==='COMPLETE'&&complete++===0)throw Error('lost PRIVATE_BODY');return response({ok:true,job:b.action==='CLAIM'?job:null});};
 await runInquiryReadWorker(f.config,f.options,f.ports);assert.equal(f.reads(),1);
 assert.deepEqual(f.calls.map(c=>c.action),['CLAIM','COMPLETE','COMPLETE']);assert.deepEqual(f.calls[1],f.calls[2]);
 const status=await readFile(join(f.root,'reader-status.json'),'utf8');assert.equal(JSON.parse(status).code,'COMPLETED');assert(!status.includes('PRIVATE_BODY'));
 await assert.rejects(access(join(f.root,'inquiry-worker.lock')));assert.deepEqual(f.closed,['shops','bello']);
}));
test('once mode stops after failed page instead of claiming another job',()=>fixture(async f=>{
 f.ports.read=async()=>{throw Error('INCOMPLETE_HISTORY');};await runInquiryReadWorker(f.config,f.options,f.ports);
 assert.deepEqual(f.calls.map(c=>c.action),['CLAIM','FAIL']);assert.equal(f.calls[1].reason,'INCOMPLETE_HISTORY');assert.deepEqual(f.statuses,['INCOMPLETE_HISTORY']);
}));
test('BELLO expired authentication stops without reading or retrying',()=>fixture(async f=>{
 f.ports.respond=async()=>response({},403);await assert.rejects(runInquiryReadWorker(f.config,{...f.options,once:false},f.ports),/BELLO_AUTH_REQUIRED/);
 assert.equal(f.reads(),0);assert.equal(f.waits.length,0);assert.deepEqual(f.statuses,['BELLO_AUTH_REQUIRED']);
}));
test('request-origin rejection is not misreported as a need to sign in again',()=>fixture(async f=>{
 f.ports.respond=async()=>response({ok:false,code:'ORIGIN_MISMATCH'},403);await assert.rejects(runInquiryReadWorker(f.config,f.options,f.ports),/ORIGIN_MISMATCH/);
 assert.equal(f.reads(),0);assert.deepEqual(f.statuses,['ORIGIN_MISMATCH']);
}));
test('wrong shop stops before provider read',()=>fixture(async f=>{
 f.ports.respond=async()=>response({ok:true,job:{...job,shopId:'other'}});await assert.rejects(runInquiryReadWorker(f.config,f.options,f.ports),/ACCOUNT_MISMATCH/);assert.equal(f.reads(),0);
}));
test('transient 503 backs off and resumes after recovery',()=>fixture(async f=>{
 let n=0;f.options.once=false;f.ports.respond=async()=>++n===1?response({},503):response({ok:true,job:null});
 f.ports.wait=async ms=>{f.waits.push(ms);if(n===2)f.controller.abort();};
 await runInquiryReadWorker(f.config,f.options,f.ports);assert.deepEqual(f.statuses,['CONNECTION_RETRY','WAITING']);assert.deepEqual(f.waits,[15000,15000]);assert.equal(f.reads(),0);
}));
test('connection failures increase delay and abort clears lock',()=>fixture(async f=>{
 let n=0;f.options.once=false;f.ports.respond=async()=>{throw Error('network private detail');};f.ports.wait=async ms=>{f.waits.push(ms);if(++n===4)f.controller.abort();};
 await runInquiryReadWorker(f.config,f.options,f.ports);assert.deepEqual(f.waits,[15000,30000,60000,60000]);await assert.rejects(access(join(f.root,'inquiry-worker.lock')));
}));
test('active worker lock refuses a second instance',()=>fixture(async f=>{
 await writeFile(join(f.root,'inquiry-worker.lock'),JSON.stringify({pid:process.pid}));await assert.rejects(runInquiryReadWorker(f.config,f.options,f.ports),/ALREADY_RUNNING/);assert.equal(f.calls.length,0);
}));
test('portable config resolves paths relative to its own file, not working directory',()=>fixture(async f=>{
 const file=join(f.root,'config.json');await writeFile(file,JSON.stringify({...f.config,root:'./queue',profileDir:'./shops',belloProfileDir:'./bello',playwrightModulePath:'./node_modules/playwright/package.json'}));const c=await loadInquiryConfig(file);assert.equal(c.root,join(f.root,'queue'));assert.equal(c.playwrightModulePath,join(f.root,'node_modules/playwright/package.json'));
}));
test('a slow login leaves both dedicated windows open; real failures close them',()=>fixture(async f=>{
 for(const timeout of [true,false])for(const service of ['bello','shops']){
 let closed=false;const context={pages:()=>[{goto:async(_url,opts)=>{assert.equal(opts.waitUntil,'domcontentloaded');const e=Error('navigation');e.name=timeout?'TimeoutError':'Error';throw e;}}],close:async()=>{closed=true;}};
 const c={...f.config,profileDir:service==='bello'?f.config.belloProfileDir:f.config.profileDir,navigateToLogin:true,launchPersistentContext:async()=>context};
 const action=()=>service==='bello'?openBelloAdminContext(c):openDedicatedLogin(c);
 if(timeout){assert.equal(await action(),context);assert.equal(closed,false);}else{await assert.rejects(action());assert.equal(closed,true);}
 }
}));

test('reader keeps a replacement tab alive and stays offline until restored tabs close',()=>fixture(async f=>{
 let offline=true,browserClosed=false;const order=[];
 const restored={close:async()=>{order.push('old-close');assert(offline);pages.splice(pages.indexOf(restored),1);if(!pages.length)browserClosed=true;}};
 const pages=[restored];const fresh={};
 const context={pages:()=>[...pages],newPage:async()=>{assert(!browserClosed);assert(offline);order.push('new');pages.push(fresh);return fresh;},setOffline:async value=>{assert(!browserClosed);assert.deepEqual(pages,[fresh]);order.push('online');offline=value;},close:async()=>{browserClosed=true;}};
 const session=await openInquiryReadSession({...f.config,launchPersistentContext:async(_dir,options)=>{assert.equal(options.offline,true);assert.equal(options.serviceWorkers,'block');return context;}});
 assert.equal(session.page,fresh);assert.deepEqual(order,['new','old-close','online']);assert.equal(browserClosed,false);
}));
