import test from "node:test";
import assert from "node:assert/strict";
import {buildSearchFieldDefs,evaluateQuery,matchesNameSearch,matchesQuickSearch,type AdvancedSearchQuery} from "../../lib/inventory/advancedSearch";
import {inventoryComparator} from "../../lib/inventory/searchSort";
import {buildScanProjection} from "../../lib/inventory/searchScanProjection";
import {mobileSearchFields,searchValidation,cachedInventorySearch,cachedSearchFields} from "../src/domain/search";
import {previewItems} from "../src/preview/fixture";
const fields=mobileSearchFields(buildSearchFieldDefs([],{categories:[{id:"z",name:"A"},{id:"a",name:"B"}],locations:[],statuses:[]}),{sales:true,ecListing:true});
const map=new Map(fields.map(field=>[field.key,field]));

test("商品名の検索は管理番号・コードを含めず、コードの詳細検索は維持",()=>{
  const item={...previewItems[0],name:"Herman Miller Chair",sku:"B005854",barcode:"202601030000",displayId:"73770285",customFields:null};
  const defs=cachedSearchFields([item],{sales:true,ecListing:true});
  assert.equal(matchesNameSearch(item,"  miller "),true);
  assert.equal(cachedInventorySearch([item],{q:"miller"},defs).length,1);
  for(const value of [item.sku,item.barcode,item.displayId]){
    assert.equal(matchesNameSearch(item,value),false);
    assert.equal(cachedInventorySearch([item],{q:value},defs).length,0);
  }
  assert.equal(matchesQuickSearch(item,item.sku),true);
  assert.equal(cachedInventorySearch([item],{advanced:{combinator:"AND",conditions:[{id:"scan",field:"barcode",operator:"equals",value:item.barcode}]}},defs).length,1);
});
test("全体を数値順に並べてから50件ずつ取り出す・同値も安定",()=>{
  const records=Array.from({length:123},(_,i)=>({id:String(i).padStart(3,"0"),quantity:i%70,customFields:null}));
  const sorted=records.sort(inventoryComparator({field:"quantity",direction:"desc"},map));
  assert.equal(sorted[0].quantity,69);
  assert.equal(new Set([...sorted.slice(0,50),...sorted.slice(50,100)].map(row=>row.id)).size,100);
  assert.ok(sorted.every((row,i)=>!i||sorted[i-1].quantity>=row.quantity));
  assert.equal(inventoryComparator({field:"quantity",direction:"desc"},map)(sorted[0],sorted[0]),0);
});
test("カテゴリはIDでなく表示名・空欄は昇降順とも末尾",()=>{
  const rows=[{id:"1",categoryId:"a"},{id:"2",categoryId:"z"},{id:"3",categoryId:null}];
  assert.deepEqual([...rows].sort(inventoryComparator({field:"categoryId",direction:"asc"},map)).map(r=>r.id),["2","1","3"]);
  assert.deepEqual([...rows].sort(inventoryComparator({field:"categoryId",direction:"desc"},map)).map(r=>r.id),["1","2","3"]);
});
test("AND・OR・数量ゼロ・価格範囲・日付条件は共通WEBエンジンで評価",()=>{
  const row={id:"1",name:"CHAIR",quantity:0,plannedSalePrice:29800,saleStartDate:"2026-09-15",customFields:null};
  const conditions:AdvancedSearchQuery["conditions"]=[{id:"1",field:"name",operator:"contains",value:"chair"},{id:"2",field:"quantity",operator:"ge",value:"1"}];
  assert.equal(evaluateQuery(row,{combinator:"AND",conditions},map),false);
  assert.equal(evaluateQuery(row,{combinator:"OR",conditions},map),true);
  assert.equal(evaluateQuery(row,{combinator:"AND",conditions:[{id:"1",field:"quantity",operator:"eq",value:"0"},{id:"2",field:"plannedSalePrice",operator:"between",value:"29000",value2:"30000"},{id:"3",field:"saleStartDate",operator:"on",value:"2026-09-15"}]},map),true);
});
test("無効な値・禁じた売上/EC項目の検索を拒否",()=>{
  const restricted=mobileSearchFields(fields,{sales:false,ecListing:false});
  for(const field of ["salePrice","saleEndDate","listingNotes","externalProductId"]) assert.ok(searchValidation({combinator:"AND",conditions:[{id:"1",field,operator:"isNotEmpty"}]},restricted));
  assert.ok(searchValidation({combinator:"AND",conditions:[{id:"1",field:"quantity",operator:"ge",value:"abc"}]},fields));
  assert.ok(searchValidation({combinator:"AND",conditions:[{id:"1",field:"saleStartDate",operator:"on",value:"2026-02-30"}]},fields));
  assert.equal(searchValidation({combinator:"OR",conditions:[{id:"1",field:"quantity",operator:"eq",value:"0"}]},fields),null);
});
test("検索・並び替えに必要な追加項目の値を取得する",()=>{
  const projection=buildScanProjection(["quantity","createdAt","categoryId","cf:packageSize"]);
  for(const key of ["quantity","createdAt","categoryId","customFields"])assert.ok(projection.attributes.includes(key));
});
test("圏外の絞込・並び替え・未取得の詳細を空欄扱いしない",()=>{
  const cached=previewItems.map(item=>({...item,details:undefined,detailLoadedAt:undefined}));
  const defs=cachedSearchFields(cached,{sales:true,ecListing:true});
  assert.deepEqual(cachedInventorySearch(cached,{sort:{field:"quantity",direction:"desc"}},defs).map(r=>r.quantity),[11,6,3]);
  assert.equal(cachedInventorySearch(cached,{advanced:{combinator:"AND",conditions:[{id:"1",field:"salePrice",operator:"isEmpty"}]}},defs).length,0);
  assert.equal(cachedInventorySearch(cached,{category:"販売中",advanced:{combinator:"AND",conditions:[{id:"1",field:"quantity",operator:"ge",value:"10"}]}},defs).length,1);
});
