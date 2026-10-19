import assert from 'node:assert/strict';
import {test} from 'node:test';
import {splitCategoryNames,inventoryCategoryIds,replaceMovementCategory} from './categories';
import {mergeZaicoUpdate} from './zaicoSyncMerge';
import {withHumanEdits} from './humanEdits';

test('half/full commas, spaces and duplicate names resolve to individual categories',()=>{
 assert.deepEqual(splitCategoryNames(' 販売中， 業者間,販売中 , '),['販売中','業者間']);
 assert.deepEqual(inventoryCategoryIds({categoryId:'old',categoryIds:[]}),[]);
 assert.deepEqual(replaceMovementCategory(['sale','wholesale','plus'],['plus','kawagoe'],'kawagoe'),['sale','wholesale','kawagoe']);
});
test('multiple-category human changes survive repeated ZAICO snapshots',()=>{
 const zaico={categoryId:'sale',categoryIds:['sale','wholesale'],extendedFields:{},customFields:{}};
 const bello={categoryId:'sale',categoryIds:['sale','wholesale','kawagoe'],extendedFields:{},customFields:{__belloEditedFields:['categoryIds']}};
 let snapshotJson=JSON.stringify({categoryIds:['sale','wholesale']});
 for(let i=0;i<3;i++){
  const result=mergeZaicoUpdate({zaico,bello,snapshotJson,isNewRecord:false});
  assert.equal(result.updates.categoryIds,undefined);assert.equal(result.updates.categoryId,undefined);assert(result.conflicts.some(c=>c.field==='categoryIds'));
  snapshotJson=result.nextSnapshotJson;
 }
});
test('category equality ignores ordering and clears both human markers after convergence',()=>{
 const common={extendedFields:{},customFields:{}};
 const result=mergeZaicoUpdate({zaico:{...common,categoryId:'sale',categoryIds:['sale','wholesale']},bello:{...common,categoryId:'wholesale',categoryIds:['wholesale','sale'],customFields:{__belloEditedFields:['categoryId','categoryIds']}},snapshotJson:JSON.stringify({categoryIds:['sale']}),isNewRecord:false});
 assert.equal(result.updates.categoryIds,undefined);
 assert(!(result.customFields.__belloEditedFields as string[]|undefined)?.includes('categoryId'));
 assert(!(result.customFields.__belloEditedFields as string[]|undefined)?.includes('categoryIds'));
});

test('inline category edits protect all category values and preserve existing custom data during ZAICO sync',()=>{
 const before={categoryId:'sale',categoryIds:['sale','wholesale'],locationId:'old'};
 const custom={memo:'keep',__belloEditedFields:['barcode']};
 const marked=withHumanEdits(before,{categoryId:'kawagoe',locationId:'new'},custom,custom);
 assert.equal(marked.memo,'keep');
 assert.deepEqual(marked.__belloEditedFields,['barcode','categoryId','locationId']);
 const result=mergeZaicoUpdate({zaico:{...before,extendedFields:{},customFields:{}},bello:{categoryId:'kawagoe',categoryIds:['kawagoe','wholesale'],locationId:'new',extendedFields:{},customFields:marked},snapshotJson:JSON.stringify(before),isNewRecord:false});
 assert.equal(result.updates.categoryIds,undefined);assert.equal(result.updates.locationId,undefined);
});
