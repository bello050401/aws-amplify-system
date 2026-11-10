import assert from "node:assert/strict";
import {evaluateQuery, buildSearchFieldDefs, isConditionComplete, type AdvancedSearchQuery} from "../lib/inventory/advancedSearch";
import {categoryFilter,inventoryCategoryIds} from "../lib/inventory/categories";
import {listFilterHref} from "../lib/inventory/listFilterNavigation";
import {buildBackToListHref,buildListReturnQuery} from "../lib/inventory/listReturnParams";
import {inventoryComparator,parseInventoryListSort} from "../lib/inventory/searchSort";
import {transformInventoryEdit} from "../lib/inventory/editTransform";
import {recordInventorySave,moveInventoryHistory} from "../lib/inventory/reversibleHistory";
import {writeFileSync,mkdirSync} from "node:fs";
import {searchResultAcknowledges} from "../lib/inventory/searchNavigationState";
import {createQuickSearchMatcher} from "../lib/inventory/advancedSearch";
let n=0;const results:string[]=[];
function test(name:string,run:()=>void){run();n++;results.push(name);console.log("PASS "+name);}
const categories=["a","b","c"].map((id,sortOrder)=>({id,name:id,parentId:null,sortOrder}));
const defs=buildSearchFieldDefs([],{categories,locations:[],statuses:[]});
const fields=new Map(defs.map(f=>[f.key,f]));
test("カテゴリOR/AND/除外、未設定・旧単一値・2番目のカテゴリを判定",()=>{
  const rows=[{id:"0",categoryIds:[]},{id:"1",categoryIds:["a"]},{id:"2",categoryIds:["a","b"]},{id:"3",categoryId:"b"},{id:"4",categoryIds:["c"]}].map(r=>({...r,customFields:null}));
  for(const [operator,ids] of [["anyOf",["1","2","3"]],["allOf",["2"]],["noneOf",["0","4"]]] as const){
    const q:AdvancedSearchQuery={combinator:"AND",conditions:[{id:"c",field:"categoryId",operator,values:["a","b"]}]};
    assert.deepEqual(rows.filter(r=>evaluateQuery(r,q,fields)).map(r=>r.id),ids);
  }
  assert.equal(evaluateQuery(rows[2],{combinator:"AND",conditions:[{id:"c",field:"categoryId",operator:"equals",value:"b"}]},fields),true);
  assert.deepEqual(inventoryCategoryIds({categoryIds:[],categoryId:"a"}),[]);
});
test("カテゴリの複数条件と数量条件を混同しない",()=>{
  const q:AdvancedSearchQuery={combinator:"AND",conditions:[{id:"c",field:"categoryId",operator:"anyOf",values:["a","b"]},{id:"n",field:"quantity",operator:"ge",value:"2"}]};
  assert(evaluateQuery({categoryIds:["b"],quantity:3,customFields:null},q,fields));
  assert(!evaluateQuery({categoryIds:["b"],quantity:1,customFields:null},q,fields));
  assert(!evaluateQuery({categoryIds:["c"],quantity:3,customFields:null},q,fields));
});
test("不正URL・空のカテゴリ選択を有効な条件にしない",()=>{
  for(const c of [null,{}, {field:"name",operator:"contains",value:3},{field:"categoryId",operator:"allOf",values:[]},{field:"categoryId",operator:"allOf",values:[2]}])assert(!isConditionComplete(c as any));
});

test("空白区切りは全キーワード一致・かなと複数語ブランドを保持",()=>{
  const row={name:"チェア（展示品） 12",customFields:null};
  assert(createQuickSearchMatcher("ちぇあ 12")(row));
  assert(!createQuickSearchMatcher("ちぇあ 13")(row));
  assert(createQuickSearchMatcher("あるペール チェア")({name:"arper Catifa チェア",customFields:null}));
  assert(createQuickSearchMatcher("fritz hansen チェア")({name:"フリッツハンセン セブン チェア",customFields:null}));
  assert(!createQuickSearchMatcher("arper チェア")({name:"Harper チェア",customFields:null}));
});
test("パネル閉じる・検索・カテゴリ変更で他の条件と表示件数を維持",()=>{
  const source="q=chair&locationId=L&categoryIds=a,b&statusId=S&limit=100&offset=50&sort=name&direction=asc&advanced=1&adv=details";
  const closed=new URL(listFilterHref(source,{advanced:null},false),"https://test");
  assert.equal(closed.searchParams.get("offset"),"50");
  for(const k of ["q","locationId","categoryIds","statusId","limit","sort","direction","adv"])assert.equal(closed.searchParams.get(k),new URLSearchParams(source).get(k));
  const searched=new URL(listFilterHref(source,{q:"arper"}),"https://test");
  assert(!searched.searchParams.has("offset"));assert.equal(searched.searchParams.get("adv"),"details");
  assert.equal(searched.searchParams.get("limit"),"100");
  const changed=new URL(listFilterHref(source,{categoryIds:"a,b,c"}),"https://test");
  assert.equal(changed.searchParams.get("locationId"),"L");assert.equal(changed.searchParams.get("categoryIds"),"a,b,c");
});
test("詳細画面から戻っても並び順・検索条件・ページを復元",()=>{
  const q=buildListReturnQuery({q:"あるペール",sort:"quantity",direction:"asc",offset:"50",limit:"100"});
  assert.equal(buildBackToListHref(q),"/inventory?"+q);
  assert(!buildBackToListHref("https://evil.invalid/?redirect=bad").includes("evil"));
});

test("標準50件表示で検索中が解除され、異なるページの応答を採用しない",()=>{
  assert(searchResultAcknowledges("q=chair", "/inventory?q=chair&limit=50&offset=0"));
  assert(!searchResultAcknowledges("q=chair&offset=50", "/inventory?q=chair&limit=50&offset=0"));
});
test("全件を数値順に並べ替えてからページ分割・同順位を固定",()=>{
  const rows=[{id:"a",quantity:100},{id:"b",quantity:2},{id:"c",quantity:10},{id:"d",quantity:null}];
  const compare=inventoryComparator(parseInventoryListSort("quantity","asc"),fields);
  assert.deepEqual(rows.sort(compare).map(r=>r.id),["b","c","a","d"]);
  assert.deepEqual(rows.slice(0,2).map(r=>r.id),["b","c"]);
  assert.deepEqual(parseInventoryListSort("untrusted","bad"),{field:"updatedAt",direction:"desc"});
});
test("保管場所とカテゴリ・名前を同じ保存として戻す・進める",()=>{
  const before={name:"チェア",categoryIds:["a"],locationId:"L1",revision:0};
  const rules={categories:{mode:"modify" as const,add:["b"],remove:[]},names:[{kind:"prefix" as const,text:"【確認】",skipExisting:true}],location:{mode:"set" as const,id:"L2"}};
  const after=transformInventoryEdit(before,rules).after;
  assert('locationId' in after);
  assert.equal(after.locationId,"L2");assert.deepEqual(after.categoryIds,["a","b"]);
  const saved=recordInventorySave(before,{...before,...after},{id:"H",operationId:"OP",actor:"QA",source:"一括編集",at:"2026-11-10T00:00:00.000Z"}).row;
  const undone=moveInventoryHistory(saved,"undo").row;assert.equal(undone.name,before.name);assert.equal(undone.locationId,"L1");
  assert.equal(moveInventoryHistory(undone,"redo").row.locationId,"L2");
  assert.throws(()=>transformInventoryEdit(before,{...rules,location:{mode:"set",id:""}}));
  const cleared=transformInventoryEdit(before,{...rules,location:{mode:"clear"}}).after;
  assert('locationId' in cleared);assert.equal(cleared.locationId,null);
});
test("カテゴリ絞り込みが複数値と旧データの両方を対象にする",()=>{
  const f=categoryFilter("b");assert.deepEqual(f.or[0],{categoryIds:{contains:"b"}});
  assert.deepEqual(inventoryCategoryIds({categoryIds:["a","b","b"],categoryId:"a"}),["a","b"]);
});
mkdirSync("artifacts/inventory-parity-20261110",{recursive:true});
writeFileSync("artifacts/inventory-parity-20261110/logic-tests.json",JSON.stringify({at:new Date().toISOString(),passed:n,results},null,2));
