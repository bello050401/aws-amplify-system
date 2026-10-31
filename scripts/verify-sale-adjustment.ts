import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runSaleAdjustment,adjustmentFingerprint,type SaleAdjustment,type AdjustmentPorts,type AdjustmentReceipt,type AdjustmentStep} from '../lib/listing/econveni/saleAdjustmentCore';

function fixture(channel:'BASE'|'YAHOO'='YAHOO'){
 const value={candidateId:'c'.repeat(64),inventoryId:'inventory',inventoryVersion:'v1',productId:'123',bindingVersion:'b1',channel,listingId:'old',price:10000,quantity:3,beforeQuantity:5,title:'【在庫3】椅子',beforeTitle:'【在庫5】椅子',fields:{products_name:'【在庫3】椅子',products_quantity:'3'},beforeFields:{products_name:'【在庫5】椅子',products_quantity:'5'}};
 const request:SaleAdjustment={...value,fingerprint:adjustmentFingerprint(value)};
 let receipt:AdjustmentReceipt|null=null,id:string|null='old',quantity=5,title=value.beforeTitle,edited=false,version='b1',uncertain=false,lost=false,commitLost=false,finalLost=false;
 const sends:AdjustmentStep[]=[],oldPage={id:'old',exists:true};
 const ports:AdjustmentPorts={
  read:async()=>receipt&&structuredClone(receipt),
  checkBinding:async r=>{assert.equal(r.bindingVersion,version);},
  observe:async(r,step)=>{
   if(step==='CLEAR')return {done:id===null,safe:id==='old'};
   if(step==='PUBLISH')return {done:id==='new',safe:id===null,newListingId:id??undefined};
   if(step==='EDIT')return {done:edited,safe:true};
   return {done:quantity===r.quantity&&title===r.title,safe:quantity===r.beforeQuantity&&title===r.beforeTitle};
  },
  commit:async(old,next)=>{assert.equal(old?.revision,receipt?.revision,'atomic CAS');receipt={...structuredClone(next),revision:(old?.revision??0)+1,updatedAt:'now'};if(commitLost&&next.pending===undefined){commitLost=false;throw Error('lost commit response');}return structuredClone(receipt);},
  send:async(r,step)=>{assert.equal(receipt?.pending,step,'reserve before send');sends.push(step);if(uncertain)throw Error('unknown outcome');if(step==='CLEAR')id=null;if(step==='EDIT')edited=true;if(step==='PUBLISH')id='new';if(step==='STOCK'){quantity=r.quantity;title=r.title;}if(lost)throw Error('lost HTTP response');},
  finish:async r=>{assert.equal(r.revision,receipt?.revision);receipt={...r,complete:true};version='new-binding';if(finalLost)throw Error('lost completion response');},
 };
 return {request,ports,sends,oldPage,get:()=>receipt,id:()=>id,stock:()=>quantity,change:()=>{version='other';},uncertain:()=>{uncertain=true;},lost:()=>{lost=true;},commitLost:()=>{commitLost=true;},finalLost:()=>{finalLost=true;},foreign:()=>{id='new';},resumePending:()=>{receipt={pk:'test',inventoryId:'inventory',request,revision:1,updatedAt:'now',done:[],pending:'CLEAR'};}};
}
test('sold Yahoo: clear binding, save remaining stock, publish NEW ID; old page remains',async()=>{
 const f=fixture();assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'WAIT');assert.deepEqual(f.sends,['CLEAR']);assert.equal(f.id(),null);
 assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'WAIT');assert.deepEqual(f.sends,['CLEAR','EDIT']);
 const result=await runSaleAdjustment(f.request,f.ports);assert.equal(result.status,'DONE');assert.equal(result.newListingId,'new');assert.deepEqual(f.sends,['CLEAR','EDIT','PUBLISH']);assert.equal(f.oldPage.exists,true);
 await runSaleAdjustment(f.request,f.ports);assert.equal(f.sends.length,3,'completed receipt remains idempotent after rebind');
});
test('BASE: e-conveni saved fields first, then quantity/title; never clear, stop or publish',async()=>{
 const f=fixture('BASE');assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'WAIT');assert.equal(f.stock(),5);
 assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'DONE');assert.equal(f.stock(),3);assert.deepEqual(f.sends,['EDIT','STOCK']);assert.equal(f.id(),'old');
});
test('binding or inventory version conflict prevents external write',async()=>{const f=fixture();f.change();await assert.rejects(runSaleAdjustment(f.request,f.ports));assert.equal(f.sends.length,0);});
test('uncertain request is persisted and never automatically resent',async()=>{const f=fixture();f.uncertain();assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'BLOCKED');assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'BLOCKED');assert.deepEqual(f.sends,['CLEAR']);assert.equal(f.get()?.pending,'CLEAR');});
test('lost HTTP response reconciles successful read-back without duplicate send',async()=>{const f=fixture();f.lost();for(let i=0;i<3;i++)await runSaleAdjustment(f.request,f.ports);assert.deepEqual(f.sends,['CLEAR','EDIT','PUBLISH']);assert.equal(f.get()?.complete,true);});
test('lost local result write resumes next step only',async()=>{const f=fixture();f.commitLost();await assert.rejects(runSaleAdjustment(f.request,f.ports));await runSaleAdjustment(f.request,f.ports);await runSaleAdjustment(f.request,f.ports);assert.deepEqual(f.sends,['CLEAR','EDIT','PUBLISH']);});
test('unknown new listing cannot be silently adopted',async()=>{const f=fixture();await runSaleAdjustment(f.request,f.ports);await runSaleAdjustment(f.request,f.ports);f.foreign();assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'BLOCKED');assert.deepEqual(f.sends,['CLEAR','EDIT']);});
test('crash after reserve cannot cause another clear',async()=>{const f=fixture();f.resumePending();assert.equal((await runSaleAdjustment(f.request,f.ports)).status,'BLOCKED');assert.equal(f.sends.length,0);});
test('confirmation cannot be reused for a different quantity',async()=>{const f=fixture();await runSaleAdjustment(f.request,f.ports);await assert.rejects(runSaleAdjustment({...f.request,fingerprint:'different',quantity:1},f.ports));assert.equal(f.sends.length,1);});
test('lost atomic completion still returns saved new ID on retry',async()=>{const f=fixture();await runSaleAdjustment(f.request,f.ports);await runSaleAdjustment(f.request,f.ports);f.finalLost();await assert.rejects(runSaleAdjustment(f.request,f.ports));assert.equal((await runSaleAdjustment(f.request,f.ports)).newListingId,'new');assert.equal(f.sends.length,3);});
