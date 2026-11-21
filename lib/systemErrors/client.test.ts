import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemErrorReporter,monitorBrowserErrors,safeErrorClass,safeErrorDigest,errorComponent} from './client';
import type {SystemErrorSignal} from './contract';
const signal: SystemErrorSignal={code:'UI_UNHANDLED',surface:'web',component:'inventory',operation:'render'};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
type ReportRequest = RequestInit & {body:string;headers:Record<string,string>;signal:AbortSignal};
type ReportResponse = {status:number};
const fetcher=(fn:(url:unknown,init:ReportRequest)=>Promise<ReportResponse>)=>fn as unknown as typeof fetch;

test('client reconstructs allowlisted payload and only 202 counts as accepted',async()=>{
 const bodies:unknown[]=[];let status=200;
 const report=createSystemErrorReporter({url:'/api/system-errors',fetcher:fetcher(async(_url,init)=>{bodies.push(JSON.parse(init.body));assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(init.headers['X-Bello-Error-Report'],'1');return {status};})});
 assert.equal(await report({...signal,message:'synthetic private text',stack:'fixture@example.invalid',url:'/inventory/fixture-id',nested:{token:'synthetic'},errorClass:'TypeError',digest:'123'} as unknown as SystemErrorSignal),false);
 assert.deepEqual(bodies,[{...signal,errorClass:'TypeError',digest:'123'}]);
 for(const response of [201,204,400,401,403,429,500,503,202]){status=response;assert.equal(await report({...signal,digest:String(response)}),response===202);}
});
test('one pending request is shared and accepted signals deduplicate for five minutes',async()=>{
 const response=deferred<ReportResponse>();let count=0,time=1000;
 const report=createSystemErrorReporter({url:'/local',now:()=>time,fetcher:fetcher(async()=>{count++;return response.promise;})});
 const first=report(signal),second=report(signal);assert.equal(first,second);assert.equal(count,1);
 response.resolve({status:202});assert.equal(await first,true);assert.equal(await report(signal),false);
 time+=299999;assert.equal(await report(signal),false);time++;assert.equal(await report(signal),true);assert.equal(count,2);
});
test('failed reports retry after cooldown; offline and invalid inputs consume no budget',async()=>{
 let online=false,count=0,time=0;
 const report=createSystemErrorReporter({url:'/local',online:()=>online,now:()=>time,fetcher:fetcher(async()=>{count++;throw Error('synthetic');})});
 assert.equal(await report(signal),false);online=true;
 assert.equal(await report({...signal,component:'invalid'} as unknown as SystemErrorSignal),false);assert.equal(count,0);
 assert.equal(await report(signal),false);assert.equal(count,1);time=29999;await report(signal);assert.equal(count,1);time=30000;await report(signal);assert.equal(count,2);
});
test('hourly budget bounds unique failures and resets after hour or clock rollback',async()=>{
 let time=100,count=0;
 const report=createSystemErrorReporter({url:'/local',now:()=>time,fetcher:fetcher(async()=>{count++;return {status:503};})});
 for(let i=0;i<25;i++)assert.equal(await report({...signal,digest:String(i)}),false);
 assert.equal(count,20);time+=3600000;await report({...signal,digest:'25'});assert.equal(count,21);
 time=0;await report({...signal,digest:'26'});assert.equal(count,22);
});
test('deadline bounds hanging headers and late credentials never start fetch',async()=>{
 const headers=deferred<Record<string,string>>();let calls=0;
 const report=createSystemErrorReporter({url:'/local',timeoutMs:5,headers:()=>headers.promise,fetcher:fetcher(async()=>{calls++;return {status:202};})});
 assert.equal(await report(signal),false);headers.resolve({'X-Fixture':'synthetic'});await Promise.resolve();await Promise.resolve();assert.equal(calls,0);
});
test('deadline releases pending slot when fetch ignores abort; late success stays unaccepted',async()=>{
 let time=0,calls=0;const responses:Array<ReturnType<typeof deferred<ReportResponse>>>=[];const signals:AbortSignal[]=[];
 const report=createSystemErrorReporter({url:'/local',timeoutMs:5,now:()=>time,fetcher:fetcher(async(_url,init)=>{calls++;signals.push(init.signal);const response=deferred<ReportResponse>();responses.push(response);return response.promise;})});
 assert.equal(await report(signal),false);assert.equal(signals[0].aborted,true);time=30000;
 const retry=report(signal);assert.equal(calls,2);responses[1].resolve({status:202});assert.equal(await retry,true);
 responses[0].resolve({status:202});await Promise.resolve();assert.equal(await report(signal),false);
});
test('safe diagnostics expose no messages, arbitrary names, digests or identifiers',()=>{
 const error=Object.assign(new TypeError('synthetic private text'),{digest:'12345'});assert.equal(safeErrorClass(error),'TypeError');assert.equal(safeErrorDigest(error),'12345');
 error.name='arbitrary-name';error.digest='fixture@example.invalid';assert.equal(safeErrorClass(error),'Unknown');assert.equal(safeErrorDigest(error),undefined);
 assert.equal(safeErrorClass({name:'TypeError',message:'synthetic'}),'Unknown');
 for(const [path,component] of [['/inventory/fixture-id?fixture=1','inventory'],['/staff-app/index.html','staff-app'],['/api/mobile/inventory/fixture-id','staff-app'],['/other/fixture-id','app']])assert.equal(errorComponent(path),component);
});
function browser(){
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 type BrowserEvent = {error?:unknown;reason?:unknown;filename?:string};
 type Listener = (event:BrowserEvent)=>void;
 const listeners=new Map<string,Set<Listener>>();let response=new Response('untouched body',{status:503});
 const original:typeof fetch=async()=>response;const window={location:new URL('https://local.invalid/inventory/fixture-id?fixture=1'),fetch:original,addEventListener:(name:string,fn:Listener)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn);},removeEventListener:(name:string,fn:Listener)=>listeners.get(name)?.delete(fn)};
 const navigator={onLine:true};Object.defineProperty(globalThis,'window',{configurable:true,value:window});Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});
 return {window,navigator,original,listeners,setResponse:(next:Response)=>response=next,emit:(name:string,event:BrowserEvent)=>{for(const handler of listeners.get(name)??[])handler(event);},restore:()=>{if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');}};
}
test('browser monitor suppresses offline, cancellations and foreign scripts and cleans listeners',()=>{
 const env=browser(),reports:SystemErrorSignal[]=[];const cleanup=monitorBrowserErrors(async(s)=>{reports.push(s);return true;},{observeFetch:false});
 try{
 assert.equal(env.window.fetch,env.original);
 env.emit('error',{error:new TypeError('synthetic'),filename:'https://local.invalid/app.js'});env.emit('unhandledrejection',{reason:new Error('synthetic')});
 env.emit('error',{error:new Error('third party'),filename:'https://foreign.invalid/ad.js'});env.emit('error',{});
 for(const error of [Object.assign(new Error('abort'),{name:'AbortError'}),new TypeError('Failed to fetch'),new TypeError('Load failed'),new TypeError('Network request failed')])env.emit('unhandledrejection',{reason:error});
 env.navigator.onLine=false;env.emit('error',{error:new Error('offline')});assert.equal(reports.length,2);
 assert.deepEqual(reports[0],{code:'UI_UNHANDLED',surface:'web',component:'inventory',operation:'render',errorClass:'TypeError'});
 cleanup();assert.equal([...env.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);env.emit('error',{error:new Error('after cleanup')});assert.equal(reports.length,2);
 }finally{cleanup();env.restore();}
});
test('API monitor preserves response identity and body and excludes auth and foreign requests',async()=>{
 const env=browser(),reports:SystemErrorSignal[]=[];const cleanup=monitorBrowserErrors(async(s)=>{reports.push(s);return true;});
 try{
 const response=new Response('original API detail',{status:503});env.setResponse(response);
 const returned=await env.window.fetch('/api/inventory/items/fixture-id?fixture=1');assert.equal(returned,response);assert.equal(await returned.text(),'original API detail');assert.equal(reports.length,1);
 for(const path of ['/api/mobile/config','/api/mobile/session','/api/inventory/health','/inventory/login','/api/system-errors','https://foreign.invalid/api/inventory/items'])await env.window.fetch(path);
 for(const status of [200,400,401,403,404,429]){env.setResponse(new Response('',{status}));await env.window.fetch('/api/mobile/inventory');}
 assert.equal(reports.length,1);assert.deepEqual(reports[0],{code:'API_SERVER_ERROR',surface:'web',component:'inventory',operation:'request'});
 cleanup();assert.equal(env.window.fetch,env.original);
 }finally{cleanup();env.restore();}
});
test('report rejection or synchronous exception cannot reject successful API requests',async()=>{
 const env=browser();
 try{for(const report of [()=>{throw Error('reporter throws');},()=>Promise.reject(Error('reporter rejects'))]){
  const cleanup=monitorBrowserErrors(report);
  try{const response=new Response('preserved',{status:500});env.setResponse(response);assert.equal(await env.window.fetch('/api/mobile/inventory'),response);env.emit('error',{error:new Error('synthetic')});await Promise.resolve();await Promise.resolve();}finally{cleanup();}
 }}finally{env.restore();}
});
test('cleanup preserves fetch subsequently installed by another owner',()=>{
 const env=browser();try{const cleanup=monitorBrowserErrors(async()=>false);const later=()=>Promise.resolve(new Response(''));env.window.fetch=later;cleanup();assert.equal(env.window.fetch,later);}finally{env.restore();}
});
