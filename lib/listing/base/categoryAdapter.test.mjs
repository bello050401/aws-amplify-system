import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const compiled=ts.transpileModule(readFileSync(new URL('./adapter.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup({enabled=true,wrongItem=false,ignoreWrite=false}={}){
 let links=[{item_category_id:10,item_id:100,category_id:1},{item_category_id:20,item_id:100,category_id:9}],writes=[];
 const api=async(url,options)=>{
   if(options.method==='POST'){
     const p=Object.fromEntries(options.body);writes.push({url,p});
     if(!ignoreWrite){
       if(url.endsWith('/add'))links.push({item_category_id:30,item_id:Number(p.item_id),category_id:Number(p.category_id)});
       else if(url.endsWith('/delete'))links=links.filter(r=>String(r.item_category_id)!==p.item_category_id);
       else throw Error('Unexpected write');
     }
   }
   return new Response(JSON.stringify({item_categories:links.map(r=>({...r,item_id:wrongItem?999:r.item_id}))}),{status:200});
 };
 const exports={},errors={BaseListingApiError:class extends Error{constructor(code,message){super(message);this.code=code}},classifyBaseHttpStatus:()=>Error('HTTP')};
 runInNewContext(compiled,{exports,URL,URLSearchParams,process:{env:{BASE_MANUAL_LISTING_ENABLED:enabled?'1':'0'}},require:id=>{
   if(id==='server-only')return {};
   if(id==='@/lib/base/oauth')return {getAccessToken:async()=>'synthetic-token'};
   if(id==='./errors')return errors;
   if(id==='@/lib/http/fetchWithTimeout')return {fetchWithTimeout:api};
   if(['@/lib/integrations/writeGuard','../commonSettings','../descriptionFormat','./visibility','./privateTestGuard'].includes(id))return {};
   throw Error('Unexpected dependency '+id);
 }});
 return {exports,get:()=>({links,writes})};
}
test('common BASE category replaces only its previous assignment and verifies the result',async()=>{
 const t=setup();await t.exports.setManualBaseCategory('100','2','1');
 assert.deepEqual(t.get().links.map(r=>r.category_id),[9,2]);
 assert.deepEqual(t.get().writes.map(r=>r.p),[{item_id:'100',category_id:'2'},{item_category_id:'10'}]);
 await t.exports.setManualBaseCategory('100','2','2');assert.equal(t.get().writes.length,2);
});
test('first common selection keeps unowned BASE categories',async()=>{
 const t=setup();await t.exports.setManualBaseCategory('100','2');
 assert.deepEqual(t.get().links.map(r=>r.category_id),[1,9,2]);
});
test('disabled writes, wrong product evidence and unacknowledged changes fail closed',async()=>{
 for(const options of [{enabled:false},{wrongItem:true},{ignoreWrite:true}]){
   const t=setup(options);await assert.rejects(t.exports.setManualBaseCategory('100','2','1'));
   if(!options.ignoreWrite)assert.equal(t.get().writes.length,0);
 }
});
