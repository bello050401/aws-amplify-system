import assert from 'node:assert/strict';
import {createQuickSearchMatcher,matchesQuickSearch,matchesNameSearch} from '../../lib/inventory/advancedSearch';
const normalize=(value:unknown)=>String(value??'').normalize('NFKC').toLocaleLowerCase('ja');
const records=[{}, {displayId:'B0001',sku:'ＳＫＵ０１',name:'【在庫2】Cassina カッシーナ チェア'},
 {displayId:'12',sku:'34',name:'56'}, {name:'ｱﾙﾌﾚｯｸｽ ＣＨＡＩＲ'}, {name:'İ I ı i É e\u0301 ①'},
 {name:null,displayId:12345}, {name:'   '}, {name:'a.b [x] $ * + ?'}, {name:'円形\nテーブル'}].map(row=>({...row,customFields:null}));
const queries=['',' ',' CASSINA ','ｃａｓｓｉｎａ','ｶｯｼｰﾅ','SKU01','B0001','23','アルフレックス','i','İ','é','1','a.b','[x]','*','\n','円形'];
let comparisons=0;
for(const nameOnly of [false,true])for(const q of queries){
 const match=createQuickSearchMatcher(q,nameOnly);
 for(const record of records){
  const fields=nameOnly?['name']:['displayId','sku','name'];
  const expected=!q.trim()||fields.some(k=>normalize((record as Record<string,unknown>)[k]).includes(normalize(q.trim())));
  assert.equal(match(record),expected,JSON.stringify({record,q,nameOnly}));
  assert.equal(nameOnly?matchesNameSearch(record,q):matchesQuickSearch(record,q),expected);
  comparisons++;
 }
}
console.log(JSON.stringify({pass:true,comparisons,fieldBoundaryPreserved:true,normalization:'NFKC + ja locale lowercase'}));
