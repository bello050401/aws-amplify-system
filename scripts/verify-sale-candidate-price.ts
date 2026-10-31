import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

async function main(){
 const ports={role:'ADMIN',rows:[{id:'test',name:'price boundary',quantity:2,categoryIds:['sale'],salePrice:null as number|null,plannedSalePrice:198000,updatedAt:'2026-11-01T00:00:00Z'}]};
 const mocks:Record<string,string>={
  '@/lib/inventory/mutationSession':'export const inventoryMutationSession=async()=>({role:ports.role});',
  '@/lib/inventory/queries':"export const listCategories=async()=>[{id:'sale',name:'販売中'}];export const toListRow=x=>x;",
  '@/lib/inventory/inventorySearchFast':'export const searchInventoryFast=async()=>({rawItems:ports.rows,total:ports.rows.length});',
  '@/lib/mobile/inventoryThumbnails':'export const inventoryThumbnails=async()=>[];',
  '@/lib/invoicing/gateway':"export const NO_STORE={'Cache-Control':'no-store'};",
  '@/lib/saleCandidates/store':'export const candidateStore=()=>({get:async()=>undefined});',
  '@/lib/saleCandidates/listingMatch':'export const exactListingInventoryIds=async()=>[];',
  '@/lib/inventory/categoryPersistence':'export const getInventoryRaw=async()=>undefined;',
 };
 const b=await build({stdin:{contents:"export {GET} from './app/api/sale-candidates/products/route';export {SaleRegistrationForm} from './components/sales/SaleRegistrationForm';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',plugins:[{name:'isolated-price-boundary',setup(builder){builder.onResolve({filter:/.*/},args=>mocks[args.path]?{path:args.path,namespace:'mock'}:undefined);builder.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
 const module={exports:{} as any};new Function('require','module','exports','ports',b.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports,ports);
 const {GET,SaleRegistrationForm}=module.exports;
 const direct={source:'DIRECT',channel:'DIRECT',name:'test',quantity:1,unitPrice:null,saleDate:'2026-11-01',orderId:'',warnings:[]};
 const price=(item:any,candidate:any)=>{const html=renderToStaticMarkup(React.createElement(SaleRegistrationForm,{item,candidate,save:async()=>({ok:false,error:'not used'}),onComplete:()=>{},onCancel:()=>{}}));const input=html.match(/<input[^>]*aria-label="販売価格"[^>]*>/)?.[0];assert.ok(input);return input.match(/value="([^"]*)"/)?.[1];};
 let count=0;
 for(const actual of [null,40000,0]){
  ports.rows[0].salePrice=actual;
  const response=await GET(new Request('https://test.invalid/api/sale-candidates/products?q=price'));assert.equal(response.status,200);
  const p=(await response.json()).items[0];assert.equal(p.price,actual??198000);assert.equal(p.salePrice,actual);
  assert.equal(price(p,direct),actual===null?'':String(actual));count++;
  assert.equal(price(p,{...direct,source:'GMAIL',channel:'MERCARI',unitPrice:null}),'');count++;
  assert.equal(price(p,{...direct,source:'GMAIL',channel:'MERCARI',unitPrice:1234}),'1234');count++;
 }
 ports.role='EDITOR';assert.equal((await GET(new Request('https://test.invalid/api/sale-candidates/products?q=price'))).status,403);count++;
 console.log(JSON.stringify({passed:count,scope:'actual search API projection to rendered sale form; reference price never substitutes a missing actual sale price'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
