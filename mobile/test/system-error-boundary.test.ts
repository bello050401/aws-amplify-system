import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import {safeErrorClass,safeErrorDigest} from '../../lib/systemErrors/client';
import {monitorNativeErrors,type NativeErrorUtils} from '../../lib/systemErrors/native';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const native={Pressable:'Pressable',Text:'Text',View:'View',StyleSheet:{create:(styles:unknown)=>styles}};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
function load(file:string,deps:Record<string,unknown>,globals:Record<string,unknown>={},suffix=''){
 const source=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const exports:Record<string,any>={};
 vm.runInNewContext(source+suffix,{exports,Date,URL,AbortController,setTimeout,clearTimeout,...globals,require:(name:string)=>{
  if(name==='react/jsx-runtime')return jsx;
  if(name==='react'&&!deps.react)return React;
  if(name in deps)return deps[name];
  return {};
 }});return exports;
}
function nodes(value:any):any[]{if(!value||typeof value!=='object')return [];if(Array.isArray(value))return value.flatMap(nodes);if(!React.isValidElement(value))return [];return [value,...nodes((value.props as any).children)];}
function boundary(report:(...args:any[])=>Promise<boolean>){
 const Boundary=load('../src/ui/SystemErrorBoundary.tsx',{'react-native':native,'../runtime/service':{reportMobileRuntimeError:report}}).SystemErrorBoundary;
 const child=React.createElement('Child');const instance=new Boundary({children:child});const updates:any[]=[];
 instance.setState=(change:any)=>{updates.push(change);instance.state={...instance.state,...change};};
 const fail=(error=new Error('synthetic private text'))=>{instance.state={...instance.state,...Boundary.getDerivedStateFromError(error)};instance.componentDidCatch(error);};
 return {instance,child,updates,fail};
}
test('mobile boundary renders child, then accessible fallback and retry; no claim before acceptance',async()=>{
 const result=deferred<boolean>(),calls:any[]=[];const screen=boundary(async(...args)=>{calls.push(args);return result.promise;});
 assert.equal(screen.instance.render(),screen.child);screen.fail();
 const fallback=nodes(screen.instance.render());assert.equal(fallback.some(n=>n.type==='Child'),false);
 assert.equal(fallback.some(n=>n.props.accessibilityRole==='status'),false);
 const retry=fallback.find(n=>n.props.accessibilityLabel==='再試行');assert.ok(retry);await flush();assert.equal(calls[0][1],'UI_RENDER_FAILED');
 result.resolve(true);await flush();
 assert.equal(nodes(screen.instance.render()).some(n=>n.props.accessibilityRole==='status'),true);
 retry.props.onPress();assert.deepEqual(plain(screen.instance.state),{failed:false,reported:false});assert.equal(screen.instance.render(),screen.child);
});
test('mobile boundary keeps fallback without sent status when reporter returns false',async()=>{
 const screen=boundary(async()=>false);screen.fail();await Promise.resolve();await Promise.resolve();
 assert.equal(screen.instance.state.failed,true);assert.equal(screen.instance.state.reported,false);
 assert.equal(nodes(screen.instance.render()).some(n=>n.props.accessibilityRole==='status'),false);
});
test('mobile boundary contains synchronous and rejected reporter failures and retains retry',async()=>{
 for(const report of [()=>{throw Error('synthetic report failure');},()=>Promise.reject(Error('synthetic report failure'))]){
  const screen=boundary(report);screen.fail();await flush();
  assert.equal(screen.instance.state.failed,true);assert.equal(screen.instance.state.reported,false);
  nodes(screen.instance.render()).find(n=>n.props.accessibilityLabel==='再試行').props.onPress();assert.equal(screen.instance.render(),screen.child);
 }
});
test('late acceptance cannot update retried, newer failure or unmounted boundary',async()=>{
 const first=deferred<boolean>(),second=deferred<boolean>();let calls=0;
 const screen=boundary(()=>++calls===1?first.promise:second.promise);screen.fail();
 nodes(screen.instance.render()).find(n=>n.props.accessibilityLabel==='再試行').props.onPress();screen.fail();
 first.resolve(true);await Promise.resolve();assert.equal(screen.instance.state.reported,false);
 screen.instance.componentWillUnmount();const before=screen.updates.length;second.resolve(true);await Promise.resolve();assert.equal(screen.updates.length,before);
});
test('LiveApp installs browser runtime listener only for verified online access, returning cleanup',()=>{
 for(const [access,offline,expected] of [[null,false,false],[{owner:'fixture-user'},true,false],[{owner:'fixture-user'},false,true]] as const){
  const effects:Array<{fn:()=>unknown;deps:unknown[]}> = [];let state=0,calls=0,cleaned=0;
 const monitor=(report:unknown,options:unknown)=>{calls++;assert.equal(report,reporter);assert.deepEqual(plain(options),{observeFetch:false});return()=>cleaned++;};
  const reporter=async()=>false;
  const fakeReact={...React,useRef:(initial:unknown)=>({current:initial}),useState:(initial:unknown)=>{const index=state++;return [index===2?access:index===4?offline:typeof initial==='function'?(initial as ()=>unknown)():initial,()=>{}];},useEffect:(fn:()=>unknown,deps:unknown[])=>effects.push({fn,deps}),useMemo:()=>null};
  const LiveApp=load('../src/ui/LiveApp.tsx',{react:fakeReact,'react-native':{...native,Platform:{OS:'web'},ActivityIndicator:'Spinner',TextInput:'Input'},'../runtime/service':{API_ORIGIN:'https://fixture.invalid',reportMobileSystemError:reporter},'../../../lib/systemErrors/client':{monitorBrowserErrors:monitor},'../domain/login':{requestedLoginMode:()=>undefined},'./theme':{colors:{}}}).LiveApp;
  LiveApp();assert.deepEqual(plain(effects[0].deps),[access,offline]);const cleanup=effects[0].fn();assert.equal(calls,Number(expected));if(expected){assert.equal(typeof cleanup,'function');(cleanup as ()=>void)();assert.equal(cleaned,1);}
 }
});
function service(platform:'web'|'ios',accepted=true){
 const reports:any[]=[];let options:any;
 let response=new Response('preserved body',{status:503});
 const exports=load('../src/runtime/service.ts',{
  'react-native':{Platform:{OS:platform},Share:{dismissedAction:'dismissed'}},
  '../../../lib/systemErrors/client':{safeErrorClass,safeErrorDigest,createSystemErrorReporter:(value:any)=>{options=value;return async(signal:unknown)=>{reports.push(signal);return accepted;};}},
  './secureTokenStorage':{SecureTokenStorage:class{}},'../domain/singleFlight':{singleFlight:(fn:()=>unknown)=>({run:fn})},
  '@react-native-async-storage/async-storage':{getItem:async()=>JSON.stringify({until:Date.now()+60000,value:{contractVersion:1,writesEnabled:true,auth:{userPoolId:'fixture-pool',userPoolClientId:'fixture-client'}}})},
  'aws-amplify':{Amplify:{configure:()=>{}}},'aws-amplify/auth/cognito':{cognitoUserPoolsTokenProvider:{setKeyValueStorage:()=>{}}},
  'aws-amplify/auth':{fetchAuthSession:async()=>({tokens:{accessToken:{payload:{username:'fixture-user'},toString:()=> 'fixture-access'},idToken:{toString:()=> 'fixture-id'}}}),getCurrentUser:async()=>({userId:'fixture-user'})},
  './sessionCookies':{nativeSessionCookies:()=> 'fixture-cookie'},
 },{window:{location:{origin:'https://fixture.invalid'}},navigator:{onLine:true},fetch:async()=>response},'\nexports.testMonitoredFetch=monitoredFetch;');
 return {exports,reports,options,setResponse:(value:Response)=>response=value};
}
test('mobile runtime reporter sends fixed diagnostics and preserves acceptance result',async()=>{
 for(const accepted of [true,false])for(const platform of ['web','ios'] as const){
  const screen=service(platform,accepted);const error=Object.assign(new TypeError('synthetic private details'),{digest:'123'});
  assert.equal(await screen.exports.reportMobileRuntimeError(error,'UI_RENDER_FAILED'),accepted);
  assert.deepEqual(plain(screen.reports),[{code:'UI_RENDER_FAILED',surface:platform==='web'?'web':'native',component:'staff-app',operation:'render',errorClass:'TypeError',digest:'123'}]);
  assert.equal(new URL(screen.options.url).pathname,'/api/system-errors');
  await screen.exports.configureMobileAuth(false);const headers=await screen.options.headers();assert.equal(headers['X-Bello-Mobile'],'1');assert.equal(headers.Cookie,platform==='web'?undefined:'fixture-cookie');
 }
});
test('mobile API instrumentation keeps original body and ignores auth/config and foreign APIs',async()=>{
 const screen=service('web');const response=new Response('original response',{status:503});screen.setResponse(response);
 const returned=await screen.exports.testMonitoredFetch('https://fixture.invalid/api/mobile/inventory');assert.equal(returned,response);assert.equal(await returned.text(),'original response');assert.equal(screen.reports.length,1);
 for(const path of ['/api/mobile/config','/api/mobile/session','/api/system-errors','https://foreign.invalid/api/mobile/inventory'])await screen.exports.testMonitoredFetch(path);
 for(const status of [200,400,401,403,404,429]){screen.setResponse(new Response('',{status}));await screen.exports.testMonitoredFetch('/api/mobile/inventory');}
 assert.equal(screen.reports.length,1);
});
test('native error monitor preserves original exception and fatal flag without awaiting reporter',async()=>{
 const calls:unknown[][]=[];const previous=(...args:unknown[])=>{calls.push(args);};let current:ReturnType<NativeErrorUtils['getGlobalHandler']>=previous;
 const utils:NativeErrorUtils={getGlobalHandler:()=>current,setGlobalHandler:handler=>{current=handler;}};
 const pending=deferred<unknown>(),reported:unknown[]=[];
 const cleanup=monitorNativeErrors(error=>{reported.push(error);return pending.promise;},utils);
 const error=new Error('synthetic exception');current(error,true);
 assert.deepEqual(calls,[[error,true]]);assert.deepEqual(reported,[error]);cleanup();assert.equal(current,previous);
 pending.resolve(false);await flush();
});
test('native report failures cannot replace original handler and cleanup respects later owner',async()=>{
 for(const reporter of [()=>{throw Error('synthetic reporter');},()=>Promise.reject(Error('synthetic reporter'))]){
  const calls:unknown[][]=[];const previous=(...args:unknown[])=>{calls.push(args);};let current:ReturnType<NativeErrorUtils['getGlobalHandler']>=previous;
  const utils:NativeErrorUtils={getGlobalHandler:()=>current,setGlobalHandler:handler=>{current=handler;}};
  const cleanup=monitorNativeErrors(reporter,utils);const error=new Error('synthetic exception');current(error,false);await flush();assert.deepEqual(calls,[[error,false]]);
  const later=()=>{};current=later;cleanup();assert.equal(current,later);
 }
 assert.doesNotThrow(()=>monitorNativeErrors(async()=>false)());
});
