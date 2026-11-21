import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import * as providers from '../../lib/procurement/providers';

function load(path:string,deps:Record<string,unknown>,hooks:Record<string,unknown>={}) {
  const compiled=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const exports:Record<string,any>={};
  vm.runInNewContext(compiled,{exports,Date,require:(name:string)=>{
    if(name==='react/jsx-runtime')return requireJsx;
    if(name==='react')return {...React,...hooks};
    if(name in deps)return deps[name];
    throw Error('Unexpected dependency '+name);
  }});
  return exports;
}
import * as requireJsx from 'react/jsx-runtime';
function nodes(value:any):any[]{
  if(value==null||typeof value==='boolean')return [];
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!React.isValidElement(value))return [];
  return [value,...nodes((value.props as any).children)];
}
const native={ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',StyleSheet:{create:(s:unknown)=>s}};
const home=load('../src/ui/HomeScreen.tsx',{'react-native':native,'@expo/vector-icons/Ionicons':'Icon','expo-image':{Image:'Image'},'../../assets/bello-system-icon.png':0}).HomeScreen;
const entry=load('../src/ui/ProcurementEntry.web.tsx',{'../../../lib/procurement/providers':providers}).ProcurementEntry;
for(const [writesEnabled,offline,expected] of [[true,false,true],[true,true,true],[false,false,false]] as const){
 test('home procurement shortcut permissions '+JSON.stringify({writesEnabled,offline}),()=>{
   let opened=0;const noop=()=>{};
   const tree=nodes(home({writesEnabled,offline,creating:false,onInventory:noop,onCreate:noop,onScan:noop,onPriceEntry:noop,onProcurement:()=>opened++}));
   const button=tree.find(n=>n.props.accessibilityLabel==='仕入れ取込');
   assert.equal(!!button,expected);
   if(button){assert.equal(button.props.disabled,offline);if(!offline){button.props.onPress();assert.equal(opened,1);}}
 });
}
test('source choices navigate within current authenticated origin without tokens',()=>{
 let closed=false;
 const tree=nodes(entry({offline:false,onClose:()=>closed=true}));
 const links=tree.filter(n=>n.type==='a');assert.equal(links.length,3);
 for(const [i,source] of providers.PROCUREMENT_PROVIDERS.entries()){
   const href=links[i].props.href;const url=new URL(href,'https://staging.invalid');
   assert.equal(url.origin,'https://staging.invalid');assert.equal(url.pathname,'/inventory/procurement');
   assert.equal(url.searchParams.get('provider'),source.key);assert.equal(url.searchParams.get('from'),'staff-app');
   assert.deepEqual([...url.searchParams.keys()],['provider','from']);
 }
 tree.find(n=>n.type==='button').props.onClick();assert.equal(closed,true);
});
for(const state of [{offline:true},{offline:false,preview:true}])test('offline/preview cannot navigate to live providers '+JSON.stringify(state),()=>{
 const tree=nodes(entry({...state,onClose:()=>{}}));assert.equal(tree.filter(n=>n.type==='a').length,0);
 assert.equal(tree.filter(n=>n.type==='button'&&n.props.disabled).length,3);
});
test('provider query allowlist preserves Restage default',()=>{
 for(const {key} of providers.PROCUREMENT_PROVIDERS)assert.equal(providers.procurementProvider(key),key);
 for(const bad of [undefined,'unknown','https://external.invalid',['yahoo']])assert.equal(providers.procurementProvider(bad),'restage');
});
const panelPath='../../app/inventory/(protected)/procurement/ProcurementPanel.tsx';
const Yahoo=()=>null,Trefac=()=>null,Restage=()=>null;
for(const {key} of providers.PROCUREMENT_PROVIDERS)test('existing provider panel opens for '+key,()=>{
 const panel=load(panelPath,{'@/lib/procurement/providers':providers,'@/app/actions/procurement':{},'@/lib/procurement/restageDraft':{},'@/lib/procurement/restageTotals':{},'./YahooProcurementPanel':Yahoo,'./TrefacProcurementPanel':Trefac,'./SupplierExtractionQueue':()=>null,'./RestageReview':{__esModule:true,default:Restage,rowProblem:()=>false}}, {useState:(initial:any)=>[typeof initial==='function'?initial():initial,()=>{}],useRef:(initial:any)=>({current:initial}),useMemo:(factory:any)=>factory()}).default;
 const tree=nodes(panel({initialProvider:key}));
 assert.equal(tree.some(n=>n.type===Yahoo),key==='yahoo');
 assert.equal(tree.some(n=>n.type===Trefac),key==='trefac');
 assert.equal(tree.some(n=>n.type==='input'&&n.props.type==='date'),key==='restage');
});
for(const role of ['EDITOR','VIEWER'])test('server procurement page honors '+role+' and fixed home return',async()=>{
 const Panel=()=>null;
 const page=load('../../app/inventory/(protected)/procurement/page.tsx',{'@/lib/procurement/providers':providers,'next/link':'Link','@/lib/amplify/requireInventoryUser':{getInventoryRole:async()=>role,canEditInventory:(r:string)=>r!=='VIEWER'},'./ProcurementPanel':Panel}).default;
 const tree=nodes(await page({searchParams:Promise.resolve({provider:'yahoo',from:'staff-app'})}));
 assert.equal(tree.find(n=>n.type==='Link').props.href,providers.STAFF_APP_HOME);
 const panel=tree.find(n=>n.type===Panel);assert.equal(!!panel,role==='EDITOR');if(panel)assert.equal(panel.props.initialProvider,'yahoo');
});

function nativeEntry(options:{offline?:boolean;preview?:boolean;fail?:boolean}={}) {
 const state:any[]=[];let cursor=0;const openingEvents:unknown[]=[];let closed=false;
 const module=load('../src/ui/ProcurementEntry.tsx',{'react-native':{...native,Linking:{openURL:async()=>{throw Error('unexpected real browser');}}},'../../../lib/procurement/providers':providers,'../runtime/service':{API_ORIGIN:'https://staging.invalid'}},{useState:(initial:any)=>{const index=cursor++;state[index]=initial;return [initial,(v:unknown)=>{state[index]=v;}];},useRef:(initial:any)=>({current:initial})});
 const tree=nodes(module.ProcurementEntry({offline:!!options.offline,preview:options.preview,onClose:()=>closed=true,openSource:async(source:unknown)=>{openingEvents.push(source);if(options.fail)throw Error('browser unavailable');}}));
 return {tree,state,openingEvents,closed:()=>closed,available:module.procurementAvailable};
}
test('native shortcut provides three browser choices and back navigation',async()=>{
 const screen=nativeEntry();assert.equal(screen.available,true);
 const choices=screen.tree.filter(n=>n.type==='Pressable'&&n.props.accessibilityLabel);
 assert.equal(choices.length,3);
 for(const [index,choice] of choices.entries())await choice.props.onPress();
 assert.deepEqual(screen.openingEvents,providers.PROCUREMENT_PROVIDERS.map(p=>p.key));
 screen.tree.find(n=>n.type==='Pressable'&&!n.props.accessibilityLabel).props.onPress();assert.equal(screen.closed(),true);
});
test('native browser errors are shown and retry remains possible',async()=>{
 const screen=nativeEntry({fail:true});const choice=screen.tree.find(n=>n.props.accessibilityLabel);
 await choice.props.onPress();assert.match(screen.state[1],/開けませんでした/);assert.equal(screen.state[0],null);
 await choice.props.onPress();assert.equal(screen.openingEvents.length,2);
});
for(const state of [{offline:true},{preview:true}])test('native blocks offline/preview source opening '+JSON.stringify(state),async()=>{
 const screen=nativeEntry(state);for(const choice of screen.tree.filter(n=>n.type==='Pressable'&&n.props.accessibilityLabel)){assert.equal(choice.props.disabled,true);await choice.props.onPress();}
 assert.equal(screen.openingEvents.length,0);
});

test('native default browser opener uses only fixed BELLO URLs without auth tokens',async()=>{
 const urls:string[]=[];
 const module=load('../src/ui/ProcurementEntry.tsx',{'react-native':{...native,Linking:{openURL:async(url:string)=>{urls.push(url);}}},'../../../lib/procurement/providers':providers,'../runtime/service':{API_ORIGIN:'https://staging.invalid'}},{useState:(initial:any)=>[initial,()=>{}],useRef:(initial:any)=>({current:initial})});
 const tree=nodes(module.ProcurementEntry({offline:false,onClose:()=>{}}));
 for(const button of tree.filter(n=>n.type==='Pressable'&&n.props.accessibilityLabel))await button.props.onPress();
 assert.deepEqual(urls,providers.PROCUREMENT_PROVIDERS.map(provider=>'https://staging.invalid'+providers.staffProcurementPath(provider.key)));
});
