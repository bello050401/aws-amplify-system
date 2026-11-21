import test from 'node:test';
import assert from 'node:assert/strict';
import {SystemErrorQueue} from '../lib/systemErrors/queue';
import {saleFailureSignal,saleErrorReceipt,saleDiagnosticRelease} from '../lib/saleCandidates/errorReporting';
const signal=saleFailureSignal('EC','EC_RESULT_UNCONFIRMED')!;
class AtomicStore {
 rows=new Map<string,any>();fail=false;
 key(table:string,key:any){return table+'|'+(key.id||key.pk+'|'+key.sk);}
 async send(command:any){
  const i=command.input;
  if(command.constructor.name==='GetCommand')return {Item:this.rows.get(this.key(i.TableName,i.Key))};
  if(command.constructor.name!=='TransactWriteCommand')throw Error('Unexpected operation');
  if(this.fail)throw Error('Network unavailable');
  const cancel=()=>{throw Object.assign(Error('Conditional failure'),{name:'TransactionCanceledException'});};
  for(const p of i.TransactItems){
   if(p.Put&&this.rows.has(this.key(p.Put.TableName,p.Put.Item)))cancel();
   if(p.Update&&Number(this.rows.get(this.key(p.Update.TableName,p.Update.Key))?.count||0)>=p.Update.ExpressionAttributeValues[':max'])cancel();
   if(p.ConditionCheck&&this.rows.get(this.key(p.ConditionCheck.TableName,p.ConditionCheck.Key))?.eventId!==p.ConditionCheck.ExpressionAttributeValues[':event'])cancel();
  }
  for(const p of i.TransactItems){
   if(p.Put)this.rows.set(this.key(p.Put.TableName,p.Put.Item),structuredClone(p.Put.Item));
   if(p.Update){const k=this.key(p.Update.TableName,p.Update.Key);this.rows.set(k,{...p.Update.Key,count:Number(this.rows.get(k)?.count||0)+1});}
  }
  return {};
 }
}
const queue=(db:AtomicStore)=>new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},db as never);
const receipt=(id='a')=>({table:'SaleTable',id:saleErrorReceipt(id.repeat(64),'EC','EC_RESULT_UNCONFIRMED')});

test('desktop diagnostics retain compiled release without worker environment and never trust a mutable release',()=>{
 const compiled='a'.repeat(40),worker='b'.repeat(40);
 assert.equal(saleDiagnosticRelease(compiled,undefined),compiled);
 assert.equal(saleDiagnosticRelease(compiled,worker),compiled);
 assert.equal(saleDiagnosticRelease(undefined,worker),worker);
 assert.equal(saleDiagnosticRelease('unknown',worker),'unknown');
 assert.equal(saleDiagnosticRelease(undefined,undefined),'unknown');
 assert.equal(saleDiagnosticRelease('untrusted runtime text',worker),null);
 assert.equal(saleDiagnosticRelease({release:compiled},worker),null);
});
test('sale incident is queued once across repeated workers and calendar days',async()=>{
 const db=new AtomicStore(),q=queue(db),a=Date.parse('2026-11-21T00:00:00Z');
 const results=await Promise.all(Array.from({length:20},(_,n)=>q.enqueue(signal,'worker',a+n*86400000,AbortSignal.timeout(5000),receipt())));
 assert.equal(results.filter(x=>!x.duplicate).length,1);assert.equal([...db.rows.values()].filter(x=>x.pk==='ERRORS').length,1);
 assert.equal([...db.rows.values()].filter(x=>x.id?.startsWith('SALE_ERROR:')).length,1);
});
test('same underlying error on different sales shares diagnostic and each receives durable atomic receipt',async()=>{
 const db=new AtomicStore(),q=queue(db),at=Date.parse('2026-11-21T00:00:00Z');
 await q.enqueue(signal,'worker',at,AbortSignal.timeout(5000),receipt('a'));
 await q.enqueue(signal,'worker',at,AbortSignal.timeout(5000),receipt('b'));
 await q.enqueue(signal,'worker',at+86400000,AbortSignal.timeout(5000),receipt('b'));
 assert.equal([...db.rows.values()].filter(x=>x.pk==='ERRORS').length,1);assert.equal([...db.rows.values()].filter(x=>x.id?.startsWith('SALE_ERROR:')).length,2);
});
test('failed queue operation does not mark reported and can retry',async()=>{
 const db=new AtomicStore(),q=queue(db);db.fail=true;
 await assert.rejects(q.enqueue(signal,'worker',Date.now(),AbortSignal.timeout(5000),receipt()));assert.equal(db.rows.size,0);
 db.fail=false;assert.equal((await q.enqueue(signal,'worker',Date.now(),AbortSignal.timeout(5000),receipt())).accepted,true);
});
test('no personal data, raw reason, business identity or instructions are forwarded',()=>{
 const value=saleFailureSignal('EC','EC_RESULT_UNCONFIRMED');assert.deepEqual(value,{code:'SALE_EC_UNCONFIRMED',surface:'server',operation:'adjust',component:'sale-automation',errorClass:'Error'});
 assert.throws(()=>saleErrorReceipt('a'.repeat(64),'EC','customer@example.com password=secret'));
 assert.equal(saleErrorReceipt('a'.repeat(64),'EC','EC_RESULT_UNCONFIRMED').includes('a'.repeat(64)),false);
 for(const reason of ['WAITING_PAYMENT','QUANTITY_UNKNOWN','UNTRUSTED_MAIL','HISTORICAL','STOCK_CHANGED'])assert.equal(saleFailureSignal('WAITING',reason),null);
});
test('authentication and rate limits stay diagnosable without becoming code-repair requests',async()=>{
 for(const reason of ['YAHOO_SALE_AUTH_REQUIRED','BASE_ORDERS_AUTH_REQUIRED','YAHOO_SALE_ACCESS_DENIED','SESSION_EXPIRED'])assert.equal(saleFailureSignal('IDENTIFY',reason)?.code,'SALE_AUTH_REQUIRED');
 assert.equal(saleFailureSignal('EC','YAHOO_SALE_RATE_LIMITED')?.code,'SALE_RATE_LIMITED');
 assert.equal(saleFailureSignal('EC','YAHOO_SALE_FORM_CHANGED')?.code,'SALE_REMOTE_FORMAT_CHANGED');
 const saved:unknown[]=[];const q=new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},{send:async(command:unknown)=>{saved.push(command);return {};}} as never);
 for(const outcome of ['AUTH_REQUIRED','RATE_LIMITED'])await q.acknowledge('2026-11-21T01:00:00.000Z#'+'a'.repeat(64),'12345678-1234-1234-1234-123456789012','NEEDS_OPERATOR',undefined,undefined,outcome);
 assert.equal(saved.length,2);
});
