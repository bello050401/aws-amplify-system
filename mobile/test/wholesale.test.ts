import assert from 'node:assert/strict';
import test from 'node:test';
import {WholesaleController,WholesaleRejectedError,sortWholesale,wholesaleAmount,type WholesalePorts,type WholesaleData,type WholesaleRow} from '../src/domain/wholesale';
import type {WholesaleSaveRequest} from '../../lib/listing/wholesale';
import {wholesaleImageSource} from '../src/domain/wholesaleImage';
const row=(i:number):WholesaleRow=>({id:`item-${i}`,name:`商品${i}`,displayId:`SKU-${i}`,imageUrl:null,updatedAt:'v1',purchaseAmount:i,shipping:0,totalCost:i,sellingDays:i,quantity:i,saleStartDate:null,alreadyWholesale:false});
const data=(count=3):WholesaleData=>({items:Array.from({length:count},(_,i)=>row(i)),canEdit:true,snapshotVersion:'snapshot',checkedAt:null,unlinkedCount:0,ambiguousCount:0,warnings:[]});
const ports=(source:WholesaleData,save:WholesalePorts['save']):WholesalePorts=>({load:async()=>source,save,newMutationId:()=> 'mutation-one'});
test('native authentication cookies never go to external catalogue image hosts',()=>{
 const headers={Cookie:'BELLO-session'};
 assert.deepEqual(wholesaleImageSource('https://bello.example/api/image','https://bello.example',headers),{uri:'https://bello.example/api/image',headers});
 for(const uri of ['https://econveni.example/image.jpg','https://bello.example.attacker.test/image','http://bello.example/image','invalid'])assert.deepEqual(wholesaleImageSource(uri,'https://bello.example',headers),{uri});
});

test('every numeric field supports both directions and missing values remain distinct and last',()=>{
 for(const key of ['purchaseAmount','shipping','totalCost','sellingDays','quantity'] as const){const rows=[{...row(2),[key]:null},{...row(1),[key]:8},{...row(0),[key]:0}];assert.deepEqual(sortWholesale(rows,key,'asc').map(i=>i.id),['item-0','item-1','item-2']);assert.deepEqual(sortWholesale(rows,key,'desc').map(i=>i.id),['item-1','item-0','item-2']);}
 assert.equal(wholesaleAmount(0),'¥0');assert.equal(wholesaleAmount(null),'未登録');
});
test('select all and individual toggle never submit more than 100',async()=>{
 let submitted=0;const c=new WholesaleController(ports(data(101),async request=>{submitted=request.items.length;return {results:request.items.map(i=>({id:i.id,status:'saved'}))};}));await c.load();c.selectAll();assert.equal(c.state.selected.length,100);c.toggle('item-100');assert.equal(c.state.selected.length,100);assert.match(c.state.error,/100/);await c.save();assert.equal(submitted,100);
});
test('partial confirmed results clear only successes and preserve identity through sorting',async()=>{
 const c=new WholesaleController(ports(data(),async request=>({results:request.items.map((i,index)=>({id:i.id,status:index===1?'failed':'saved',message:index===1?'競合':'追加済み'}))})));await c.load();c.selectAll();const selected=[...c.state.selected];sortWholesale(c.state.data!.items,'quantity','desc');assert.deepEqual(c.state.selected,selected);await c.save();assert.deepEqual(c.state.selected,['item-1']);assert.equal(c.state.data!.items[0].alreadyWholesale,true);assert.equal(c.unknown,false);c.clear();assert.equal(c.state.selected.length,0);
});
test('unknown network result retries identical mutation and versions; controls stay locked',async()=>{
 const requests:WholesaleSaveRequest[]=[];const c=new WholesaleController(ports(data(),async request=>{requests.push(request);if(requests.length===1)throw Error('network');return {results:request.items.map(i=>({id:i.id,status:'already'}))};}));await c.load();c.toggle('item-0');await c.save();assert.equal(c.unknown,true);c.clear();assert.deepEqual(c.state.selected,['item-0']);await c.save();assert.deepEqual(requests[0],requests[1]);assert.equal(c.unknown,false);assert.deepEqual(c.state.selected,[]);
});
test('known pre-write rejection unlocks reload and selection',async()=>{
 const c=new WholesaleController(ports(data(),async()=>{throw new WholesaleRejectedError('権限を確認してください');}));await c.load();c.toggle('item-0');await c.save();assert.equal(c.unknown,false);assert.equal(c.state.error,'権限を確認してください');c.clear();assert.deepEqual(c.state.selected,[]);await c.load();assert.equal(c.state.error,'');
});
test('backend unknown response remains reconcilable with original request',async()=>{
 const requests:WholesaleSaveRequest[]=[];const c=new WholesaleController(ports(data(),async request=>{requests.push(request);return {results:request.items.map(i=>({id:i.id,status:requests.length===1?'unknown':'already'}))};}));await c.load();c.toggle('item-0');await c.save();assert.equal(c.unknown,true);await c.save();assert.deepEqual(requests[0],requests[1]);assert.equal(c.unknown,false);
});
test('read-only viewers cannot select or save; reload excludes already tagged items',async()=>{
 let saves=0;const source=data();source.canEdit=false;const c=new WholesaleController(ports(source,async()=>{saves++;return {results:[]};}));await c.load();c.selectAll();c.toggle('item-0');await c.save();assert.equal(c.state.selected.length,0);assert.equal(saves,0);source.canEdit=true;await c.load();c.toggle('item-0');source.items[0].alreadyWholesale=true;await c.load();assert.equal(c.state.selected.length,0);
});
