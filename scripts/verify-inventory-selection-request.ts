import assert from 'node:assert/strict';
import {parseSelectionRequest,MAX_EDIT_SELECTION} from '../lib/inventory/selectionRequest';
const input={requestId:'test-operation',mode:'edit',ids:['item-2','item-1','item-2']};
assert.deepEqual(parseSelectionRequest(input),{...input,ids:['item-2','item-1']});
assert.deepEqual(input.ids,['item-2','item-1','item-2']);
for(const mode of ['edit','undo','redo','history'])assert.equal(parseSelectionRequest({...input,mode})?.mode,mode);
for(const invalid of [null,[],{},'all',{...input,ids:[]},{...input,ids:['']},{...input,ids:['../secret']},{...input,ids:[null]},
  {...input,ids:['item','*']},{...input,requestId:''},{...input,mode:'delete'},{...input,mode:'publish'},
  {...input,ids:Array.from({length:MAX_EDIT_SELECTION+1},(_,i)=>'item-'+i)}])assert.equal(parseSelectionRequest(invalid),null);
const selected=parseSelectionRequest({...input,ids:['item-1','item-2']})!;
input.ids.push('later-search-result');
assert.deepEqual(selected.ids,['item-1','item-2']);
assert.equal(parseSelectionRequest({...input,ids:Array.from({length:MAX_EDIT_SELECTION},(_,i)=>'item-'+i)})?.ids.length,MAX_EDIT_SELECTION);
console.log('PASS selection order/deduplication, immutable targets, four allowed modes, malformed IDs, empty/oversized requests and upper bound');
