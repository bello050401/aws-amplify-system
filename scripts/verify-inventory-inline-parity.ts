import assert from "node:assert/strict";
import {writeFileSync,mkdirSync} from "node:fs";
import {validateInlineChanges,isInlineEditableColumn,INLINE_EDIT_FIELDS} from "../lib/inventory/inlineEdit";
import {browserListRow} from "../lib/inventory/browserListRow";
import {withHumanEdits,humanEditedFields} from "../lib/inventory/humanEdits";
import {recordInventorySave,moveInventoryHistory,readEditHistory} from "../lib/inventory/reversibleHistory";
import {createAdvancedSearchMatcher,evaluateCondition,completeConditions,buildSearchFieldDefs,STATIC_SEARCH_FIELDS} from "../lib/inventory/advancedSearch";
const results:string[]=[];
function test(name:string,fn:()=>void){fn();results.push(name);console.log("PASS "+name);}
const defs=[
 {fieldKey:"color",label:"色",fieldType:"SELECT",options:["赤","青"],required:false,isActive:true},
 {fieldKey:"amount",label:"数値",fieldType:"NUMBER",options:[],required:false,isActive:true},
 {fieldKey:"date",label:"日付",fieldType:"DATE",options:[],required:false,isActive:true},
 {fieldKey:"memo",label:"メモ",fieldType:"TEXTAREA",options:[],required:true,isActive:true},
 {fieldKey:"old",label:"廃止",fieldType:"TEXT",options:[],required:false,isActive:false},
];
test("一覧の全編集列と有効な追加項目を認識、内部項目・IDは編集不可",()=>{
 for(const key of Object.keys(INLINE_EDIT_FIELDS))assert(isInlineEditableColumn(key,defs));
 for(const key of ["cf:color","cf:amount","cf:date","cf:memo"])assert(isInlineEditableColumn(key,defs));
 for(const key of ["id","sku","updatedAt","cf:old","cf:unknown","cf:__belloEditedFields"])assert(!isInlineEditableColumn(key,defs));
});
test("小数寸法・日付・単位・複数カテゴリ・追加項目の型と選択肢",()=>{
 validateInlineChanges({market:"ヤフオク",transactionType:"買受"},defs);
 assert.throws(()=>validateInlineChanges({market:"未定義の販売先"},defs));
 assert.throws(()=>validateInlineChanges({transactionType:"未定義の取引"},defs));
 validateInlineChanges({width:"71.5",height:"約80～90",unit:"脚",barcode:"2026042311254",saleEndDate:"2026-11-10",categoryIds:["a","b"],customFieldChanges:{amount:2.5,date:"2026-11-10",color:"赤",memo:"複数行\n保持"}},defs);
 for(const changes of [{quantity:"2"},{quantity:-1},{salePrice:NaN},{saleEndDate:"2026-02-30"},{id:"hack"},{customFieldChanges:{color:"緑"}},{customFieldChanges:{amount:"2"}},{customFieldChanges:{date:"2026-02-30"}},{customFieldChanges:{memo:null}},{customFieldChanges:{old:"x"}},{customFieldChanges:{__belloEditedFields:"x"}},{customFieldChanges:{constructor:"x"}}])assert.throws(()=>validateInlineChanges(changes as any,defs));
});
test("追加項目パッチは他の値・仕入元情報・編集保護を保持",()=>{
 const old={color:"赤",memo:"手入力",__restageImport:{sourceId:"test"},__belloEditedFields:["note"]};
 const next=withHumanEdits({width:"60"},{width:"71.5"},old,{...old,color:"青"});
 assert.equal(next.memo,"手入力");assert.deepEqual(next.__restageImport,old.__restageImport);
 assert.deepEqual([...humanEditedFields(next)].sort(),["customFields.color","note","width"]);
});
test("ブラウザ転送を削減しても全編集値・競合版・画像参照は不変",()=>{
 const row:any={id:"a",name:"チェア",quantity:2,width:"71.5",note:"全文\n".repeat(500),categoryIds:["a","b"],updatedAt:"v1",revision:7,mainImageSignedUrl:"https://example.test/photo",customFields:{memo:"全文",amount:0,__belloEditHistory:{data:"x".repeat(20000)},__restageImport:{sourceId:"secret"}},counterpartyAddress:"detail-only",images:[{data:"detail-only"}]};
 const copied=browserListRow(row);
 for(const key of ["id","name","quantity","width","note","categoryIds","updatedAt","revision","mainImageSignedUrl"])assert.deepEqual((copied as any)[key],row[key]);
 assert.deepEqual(copied.customFields,{memo:"全文",amount:0});assert(!("counterpartyAddress" in copied));assert(!("images" in copied));
 assert.equal(row.customFields.__restageImport.sourceId,"secret");assert(JSON.stringify(copied).length<JSON.stringify(row).length/2);
});
test("マスタ読込前後の詳細検索判定が同一（カテゴリ2個・AND/OR・日付・数値）",()=>{
 const full=new Map(buildSearchFieldDefs(defs.filter(d=>d.isActive),{categories:[{id:"a",name:"販売中"},{id:"b",name:"確認"}],locations:[{id:"l",name:"所沢"}],statuses:[]}).map(f=>[f.key,f]));
 const early=new Map(STATIC_SEARCH_FIELDS.map(f=>[f.key,f]));
 const conditions:any[]=[{id:"c",field:"categoryId",operator:"allOf",values:["a","b"]},{id:"q",field:"quantity",operator:"ge",value:"2"},{id:"d",field:"updatedAt",operator:"equals",value:"2026-11-10"}];
 for(const combinator of ["AND","OR"] as const)for(let mask=0;mask<8;mask++){
  const query={combinator,conditions:conditions.filter((_,i)=>mask&(1<<i))},compiled=createAdvancedSearchMatcher(query,early);
  for(let i=0;i<500;i++){
   const row:any={id:String(i),categoryIds:i%2?["a","b"]:["a"],quantity:i%5,updatedAt:i%3?"2026-11-10T02:00:00Z":"2026-11-08T02:00:00Z",customFields:null};
   const complete=completeConditions(query),expected=!complete.length|| (combinator==="OR"?complete.some(c=>evaluateCondition(row,full.get(c.field)!,c)):complete.every(c=>evaluateCondition(row,full.get(c.field)!,c)));
   assert.equal(compiled(row),expected);
  }
 }
});
mkdirSync("artifacts/inventory-parity-20261110",{recursive:true});
writeFileSync("artifacts/inventory-parity-20261110/inline-tests.json",JSON.stringify({status:"PASS",groups:results,compiledSearchComparisons:8000},null,2));
