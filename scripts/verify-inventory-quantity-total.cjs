// Run the real server action with deterministic data/auth substitutes. No AWS writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const out=path.resolve('artifacts/zaico-operation-audit-20261111');
const source=`
export const getInventoryRole=async()=>process.env.QA_DENY==='1'?null:'VIEWER';
export const countActiveInventory=async()=>3;
export const listCategories=async()=>[];export const listLocations=listCategories;export const listStatuses=listCategories;export const listCustomFieldDefinitions=listCategories;
function result(filters){if(filters.q==='error')throw Error('Synthetic unavailable');return {items:[{quantity:1}],total:3,totalQuantity:filters.q==='zero'?0:13};}
export async function listInventorySimpleSearch(filters){return result(filters);}
export async function listInventoryAdvanced(query,fields,options,filters){if(query.conditions.length!==1||filters.categoryIds[0]!=='B')throw Error('Filter lost');return {items:[],total:2,totalQuantity:7};}
`;
async function main(){
 fs.mkdirSync(out,{recursive:true});const file=path.join(out,'quantity-action.cjs');
 await esbuild.build({entryPoints:['app/actions/inventoryCount.ts'],bundle:true,platform:'node',format:'cjs',outfile:file,packages:'external',plugins:[{name:'test-boundaries',setup(b){
 b.onResolve({filter:/^@\/lib\/(amplify\/requireInventoryUser|inventory\/(inventoryPage|queries))$/},a=>({path:a.path,namespace:'qa'}));
 b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:source,loader:'ts'}));
 }}]});
 const {getInventoryQuantityTotalAction:sum}=require(file),checks=[];
 async function check(name,fn){await fn();checks.push(name);}
 await check('全検索対象の合計を返す（先頭ページの数量1ではなく13）',async()=>assert.deepEqual(await sum({q:'table'}),{ok:true,totalQuantity:13}));
 await check('0点は正常な0として返す',async()=>assert.deepEqual(await sum({q:'zero'}),{ok:true,totalQuantity:0}));
 await check('取得失敗を0点に変換しない',async()=>assert.deepEqual(await sum({q:'error'}),{ok:false}));
 await check('詳細条件とカテゴリ条件を同時に維持',async()=>assert.deepEqual(await sum({categoryIds:['B']},JSON.stringify({combinator:'AND',conditions:[{id:'1',field:'quantity',operator:'ge',value:'2'}]})),{ok:true,totalQuantity:7}));
 await check('未認証を拒否',async()=>{process.env.QA_DENY='1';assert.deepEqual(await sum({}),{ok:false});delete process.env.QA_DENY;});
 await check('不正入力を拒否',async()=>{for(const [filter,adv] of [[null], [{q:123}], [{categoryIds:'B'}],[{},'{'],[{},JSON.stringify({conditions:[],combinator:'INVALID'})]])assert.deepEqual(await sum(filter,adv),{ok:false});});
 fs.writeFileSync(path.join(out,'quantity-tests.json'),JSON.stringify({at:new Date().toISOString(),passed:checks.length,checks},null,2));console.log('PASS quantity total: '+checks.length+' cases');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
