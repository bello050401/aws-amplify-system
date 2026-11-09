import assert from 'node:assert/strict';
import {transformInventoryEdit,transformName,validateEditRules,parseBracketPairs,type NameRule} from '../lib/inventory/editTransform';
import {inventoryDiff,applyInventoryDiff,recordInventorySave,moveInventoryHistory,readEditHistory,type EditHistoryEntry} from '../lib/inventory/reversibleHistory';
let tests=0;
const check=(name:string,fn:()=>void)=>{fn();tests++;console.log('PASS '+name);};
const rules=(names:NameRule[])=>({categories:{mode:'keep' as const},names});
const meta=(n:number):Omit<EditHistoryEntry,'version'|'changes'>=>({id:'history'+n,operationId:'operation'+n,actor:'test',source:'test',at:new Date(n).toISOString()});
check('category add/remove preserves unrelated IDs and order',()=>{
  const r={categories:{mode:'modify' as const,add:['c','a'],remove:['b','absent']},names:[]};
  assert.deepEqual(transformInventoryEdit({name:'椅子',categoryIds:['a','b']},r).after.categoryIds,['a','c']);
  assert.deepEqual(transformInventoryEdit({name:'椅子',categoryIds:['a','x']},r).after.categoryIds,['a','x','c']);
  assert.throws(()=>validateEditRules({categories:{mode:'modify',add:['a'],remove:['a']},names:[]}));
});
check('prefix, literal replacement, nested bracket transformations and malformed pairs',()=>{
  assert.equal(transformName('椅子（展示品）',[{kind:'brackets',bracket:'wide',content:false}]),'椅子展示品');
  assert.equal(transformName('椅子（展示（傷）品）',[{kind:'brackets',bracket:'wide',content:true}]),'椅子');
  assert.equal(transformName('【展示品】椅子',[{kind:'convert',from:'memo',to:'wide'}]),'（展示品）椅子');
  assert.equal(transformName('【市川】椅子',[{kind:'prefix',text:'【市川】',skipExisting:true}]),'【市川】椅子');
  assert.equal(transformName('a.b a.b',[{kind:'replace',from:'.',to:'$'}]),'a$b a$b');
  assert.equal(transformName(' A　( B ) ',[{kind:'brackets',bracket:'narrow',content:false}]),' A　 B  ');
  for(const value of ['椅子（','椅子】','【(】)','【（】）'])assert.throws(()=>parseBracketPairs(value));
  assert.throws(()=>transformName('（だけ）',[{kind:'brackets',bracket:'wide',content:true}]));
  assert.throws(()=>validateEditRules(rules([{kind:'replace',from:'',to:'x'}])));
  assert.throws(()=>transformName('x'.repeat(2000),[{kind:'prefix',text:'z',skipExisting:true}]));
});
check('two undo/redo, branch replacement, no-op and history cap',()=>{
  let row:Record<string,unknown>={name:'S0',quantity:5,categoryIds:['a'],revision:0};
  row=recordInventorySave(row,{...row,name:'S1',quantity:4},meta(1)).row;
  row=recordInventorySave(row,{...row,name:'S2'},meta(2)).row;
  row=moveInventoryHistory(row,'undo').row;assert.equal(row.name,'S1');
  row=moveInventoryHistory(row,'undo').row;assert.equal(row.name,'S0');assert.equal(row.quantity,5);
  row=moveInventoryHistory(row,'redo').row;row=moveInventoryHistory(row,'redo').row;assert.equal(row.name,'S2');
  assert.equal(readEditHistory(row).entries.length,2);
  const old=JSON.stringify(readEditHistory(row));row=recordInventorySave(row,{...row,updatedAt:'metadata only'},meta(3)).row;assert.equal(JSON.stringify(readEditHistory(row)),old);
  row=moveInventoryHistory(row,'undo').row;row=recordInventorySave(row,{...row,name:'branch'},meta(4)).row;
  assert.throws(()=>moveInventoryHistory(row,'redo'));
  row=recordInventorySave(row,{...row,name:'S3'},meta(5)).row;assert.equal(readEditHistory(row).entries.length,2);
  assert.throws(()=>moveInventoryHistory(row,'undo','operation1'));
});
check('null, unset, empty, long text, category order, image references round trip',()=>{
  const before={name:'椅子',note:null,unit:'',images:[{storageKey:'inventory/a.jpg'}],categoryIds:['a','b','c'],customFields:'{"座面高":"43","__belloEditedFields":["name"]}'};
  const after={...before,note:'',unit:undefined,quantity:0,images:[{storageKey:'inventory/b.jpg'}],categoryIds:['b','a'],customFields:'{"座面高":"44","__belloEditedFields":["name","width"]}'};
  delete after.unit;
  const diff=inventoryDiff(before,after),back=applyInventoryDiff(after,diff,'undo');
  assert.equal(back.note,null);assert.equal(back.unit,'');assert.equal(Object.hasOwn(back,'quantity'),false);
  assert.deepEqual(back.categoryIds,before.categoryIds);assert.deepEqual(back.images,before.images);
  assert.deepEqual(JSON.parse(String(back.customFields)),{'座面高':'43',__belloEditedFields:['name','width']});
  const text='a'.repeat(10000)+'b'+'末尾',textAfter=text.replace('b','c');
  const d=inventoryDiff({note:text},{note:textAfter});assert.equal(d[0].kind,'text');assert.equal(applyInventoryDiff({note:textAfter},d,'undo').note,text);
});
check('10,000 edits with deterministic randomized reference model and bounded history',()=>{
  let seed=738162;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  let row:Record<string,unknown>={name:'start',quantity:10,categoryIds:['a'],revision:0};
  let past:Record<string,unknown>[]=[{name:'start',quantity:10,categoryIds:['a']}],cursor=0,maxBytes=0;
  const business=(v:Record<string,unknown>)=>({name:v.name,quantity:v.quantity,categoryIds:v.categoryIds});
  for(let i=0;i<10000;i++){
    const action=Math.floor(random()*3);
    if(action===0||past.length===1){
      const next={...row,name:'商品'+i,quantity:Math.floor(random()*10),categoryIds:random()<.5?['a','b']:['b','c','a']};
      past=past.slice(0,cursor+1);past.push(business(next));if(past.length>3)past.shift();cursor=past.length-1;
      row=recordInventorySave(row,next,meta(i)).row;
    }else if(action===1&&cursor>0){cursor--;row=moveInventoryHistory(row,'undo').row;}
    else if(action===2&&cursor<past.length-1){cursor++;row=moveInventoryHistory(row,'redo').row;}
    assert.deepEqual(business(row),past[cursor]);assert.equal(readEditHistory(row).entries.length<=2,true);
    maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(readEditHistory(row))));
  }
  assert.ok(maxBytes<4000);console.log(JSON.stringify({randomOperations:10000,maxHistoryBytes:maxBytes}));
});
console.log(JSON.stringify({passed:tests,storage:'isolated in-memory reference model'}));
