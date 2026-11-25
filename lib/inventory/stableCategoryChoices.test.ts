import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stableCategoryChoices} from './stableCategoryChoices';

const masters=[
  {value:'repair',label:'補修待ち'},
  {value:'photo',label:'撮影待ち'},
  {value:'listing',label:'出品待ち'},
  {value:'sale',label:'販売中'},
];
const ids=(items:readonly {value:string}[])=>items.map(item=>item.value);

test('keeps the familiar workflow order on a new mount, without alphabetizing',()=>{
  assert.deepEqual(ids(stableCategoryChoices([],masters)),['repair','photo','listing','sale']);
  assert.deepEqual(masters.map(row=>row.label),['補修待ち','撮影待ち','出品待ち','販売中']);
});
test('refresh order and updated labels cannot move existing category targets',()=>{
  const before=stableCategoryChoices([],masters);
  const refreshed=stableCategoryChoices(before,[{value:'sale',label:'販売中'}, {...masters[1],label:'撮影待ち（更新）'},masters[0],masters[2]]);
  assert.deepEqual(ids(refreshed),ids(before));
  assert.equal(refreshed[1].label,'撮影待ち（更新）');
});
test('new masters append; deleted masters disappear without reordering survivors',()=>{
  const before=stableCategoryChoices([],masters);
  const extra={value:'hold',label:'保留'};
  const updated=stableCategoryChoices(before,[extra,masters[3],masters[1],masters[0]]);
  assert.deepEqual(ids(updated),['repair','photo','sale','hold']);
  assert.equal(new Set(ids(updated)).size,updated.length);
});
test('empty initial master loading does not invent selected category positions',()=>{
  const waiting=stableCategoryChoices([],[]);
  assert.deepEqual(waiting,[]);
  assert.deepEqual(ids(stableCategoryChoices(waiting,masters)),['repair','photo','listing','sale']);
});
