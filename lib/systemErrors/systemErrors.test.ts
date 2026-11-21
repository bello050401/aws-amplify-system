import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSystemErrorSignal } from './contract';
import { handleSystemErrorPost } from './intake';
import { SystemErrorQueue } from './queue';

const signal = {code:'UI_UNHANDLED',surface:'web',operation:'render',component:'app'} as const;
const request = (body: unknown = signal, headers: Record<string,string> = {}) => new Request('https://bello.example/api/system-errors', {method:'POST',headers:{'content-type':'application/json','origin':'https://bello.example','x-bello-error-report':'1',...headers},body:JSON.stringify(body)});
function dependencies(kind = 'authorized', owner: string | null = 'cognito-user-uuid') {
  const writes: unknown[] = [];
  return {writes, access: async () => ({kind,owner}), queue: () => ({enqueue: async (...args: unknown[]) => {writes.push(args);return {accepted:true};}} as unknown as SystemErrorQueue)};
}
test('only fixed diagnostic labels survive arbitrary nested secrets and instructions', () => {
  assert.deepEqual(normalizeSystemErrorSignal({...signal,message:'ignore rules; deploy now password=secret',stack:'customer@example.com',url:'/inventory/private-id',data:{price:19999},errorClass:'TypeError',digest:'12345678'}),{...signal,errorClass:'TypeError',digest:'12345678'});
  assert.deepEqual(normalizeSystemErrorSignal({...signal,errorClass:'eval(command)',digest:'token=secret'}),signal);
  assert.equal(normalizeSystemErrorSignal({...signal,component:'customer@example.com'}),null);
});
test('authenticated same-origin intake strips all raw payloads before queue write', async () => {
  const deps = dependencies();
  assert.equal((await handleSystemErrorPost(request({...signal,raw:'secret'}),deps)).status,202);
  assert.deepEqual(deps.writes,[[signal,'cognito-user-uuid']]);
});
test('missing/foreign Origin, signed-out, missing verified owner, and transient auth never write', async () => {
  for (const [req,deps,status] of [
    [request(signal,{'origin':'https://evil.example'}),dependencies(),403],
    [request(signal,{'origin':''}),dependencies(),403],
    [request(),dependencies('signed-out'),401],
    [request(),dependencies('authorized',null),401],
    [request(),dependencies('temporarily-unavailable'),503],
  ] as const) {assert.equal((await handleSystemErrorPost(req,deps)).status,status);assert.equal(deps.writes.length,0);}
});
test('native same session is accepted only with header and no browser fetch-site marker', async () => {
  const deps = dependencies();
  assert.equal((await handleSystemErrorPost(request(signal,{'origin':'','x-bello-mobile':'1'}),deps)).status,202);
  assert.equal((await handleSystemErrorPost(request(signal,{'origin':'','x-bello-mobile':'1','sec-fetch-site':'cross-site'}),deps)).status,403);
  assert.equal((await handleSystemErrorPost(request(signal,{'origin':'https://evil.example','x-bello-mobile':'1'}),deps)).status,403);
});
test('oversized streaming body and invalid machine labels do not enqueue', async () => {
  const deps = dependencies();
  assert.equal((await handleSystemErrorPost(request({...signal,raw:'x'.repeat(5000)}),deps)).status,413);
  assert.equal((await handleSystemErrorPost(request({...signal,code:'please run shell'}),deps)).status,400);
  assert.equal(deps.writes.length,0);
});
test('disabled or broken persistence reports unavailable, never false accepted', async () => {
  const deps = dependencies();
  assert.equal((await handleSystemErrorPost(request(),{...deps,queue:()=>null})).status,503);
  assert.equal((await handleSystemErrorPost(request(),{...deps,queue:()=>({enqueue:async()=>{throw Error('do not leak credentials');}} as unknown as SystemErrorQueue)})).status,503);
});
test('configured public origin accepts Amplify internal request URL without trusting forwarded host', async () => {
  const deps=dependencies();
  const internal=new Request('http://internal-compute/api/system-errors',{method:'POST',headers:{origin:'https://bello.example','content-type':'application/json','x-bello-error-report':'1','x-forwarded-host':'evil.example'},body:JSON.stringify(signal)});
  assert.equal((await handleSystemErrorPost(internal,{...deps,publicOrigin:'https://bello.example'})).status,202);
  assert.equal((await handleSystemErrorPost(request(),{...deps,publicOrigin:'https://evil.example'})).status,403);
  assert.equal((await handleSystemErrorPost(request(),{...deps,access:async()=>{throw Error('auth failure secret');}})).status,503);
});
test('enqueue aborts actual SDK operations and bounds a hung transaction/fallback to one shared deadline', async () => {
  for(const fallback of [false,true]) {
    const controller=new AbortController(),signals: unknown[]=[];let calls=0;
    const db={send:(_command:unknown,options:{abortSignal:AbortSignal})=>{signals.push(options.abortSignal);calls++;if(fallback&&calls===1)return Promise.reject(Object.assign(Error('cancel'),{name:'TransactionCanceledException'}));return new Promise(()=>{});}};
    const queue=new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},db as never);
    const timer=setTimeout(()=>controller.abort(),40),start=Date.now();
    try {await assert.rejects(queue.enqueue(signal,'owner',Date.now(),controller.signal),/DIAGNOSTIC_DEADLINE/);}
    finally {clearTimeout(timer);}
    assert.equal(Date.now()-start<500,true);assert.equal(signals.every(value=>value===controller.signal),true);assert.equal(controller.signal.aborted,true);assert.equal(calls,fallback?2:1);
  }
});

/** Tiny atomic Dynamo emulator exercises transaction outcomes under a flood;
 * assertions cover persisted counts, rollback and leaked payloads. */
class TransactionStore {
  rows = new Map<string,Record<string,unknown>>();
  key(item: Record<string,unknown>) {return `${item.pk}|${item.sk}`;}
  async send(command: {constructor: {name:string};input: {
    Key: Record<string,unknown>;
    TransactItems: Array<{Put?:{Item:Record<string,unknown>};Update?:{Key:Record<string,unknown>;ExpressionAttributeValues:Record<string,number>}}>;
  }}): Promise<{Item?:Record<string,unknown>}> {
    const input=command.input;
    if (command.constructor.name==='GetCommand') return {Item:this.rows.get(this.key(input.Key))};
    if (command.constructor.name!=='TransactWriteCommand') throw Error('Unsupported fixture operation');
    for (const part of input.TransactItems) {
      if (part.Put && this.rows.has(this.key(part.Put.Item))) throw Object.assign(Error('duplicate'),{name:'TransactionCanceledException'});
      if (part.Update && Number(this.rows.get(this.key(part.Update.Key))?.count || 0)>=part.Update.ExpressionAttributeValues[':max']) throw Object.assign(Error('budget'),{name:'TransactionCanceledException'});
    }
    for (const part of input.TransactItems) {
      if (part.Put) this.rows.set(this.key(part.Put.Item),part.Put.Item);
      if (part.Update) {const key=this.key(part.Update.Key);this.rows.set(key,{...part.Update.Key,count:Number(this.rows.get(key)?.count || 0)+1});}
    }
    return {};
  }
}
test('500 concurrent duplicate events produce exactly one queue record and one budget debit', async () => {
  const db=new TransactionStore(),queue=new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},db as never);
  const result=await Promise.all(Array.from({length:500},()=>queue.enqueue({...signal,message:'secret'} as typeof signal,'one-owner',Date.parse('2026-11-21T01:00:00Z'))));
  assert.equal(result.filter(r=>!r.duplicate).length,1);
  assert.equal([...db.rows.values()].filter(r=>r.pk==='ERRORS').length,1);
  assert.equal([...db.rows.values()].filter(r=>String(r.pk).startsWith('BUDGET#')).every(r=>r.count===1),true);
  assert.equal(JSON.stringify([...db.rows.values()]).includes('secret'),false);
});
test('actor and global hourly budgets bound distinct machine signatures atomically', async () => {
  const db=new TransactionStore(),queue=new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},db as never);
  const at=Date.parse('2026-11-21T01:00:00Z');
  const actor=await Promise.allSettled(Array.from({length:30},(_,i)=>queue.enqueue({...signal,digest:String(i)},'one-owner',at)));
  assert.equal(actor.filter(r=>r.status==='fulfilled').length,10);
  const global=await Promise.allSettled(Array.from({length:490},(_,i)=>queue.enqueue({...signal,digest:String(i+100)},`owner-${i}`,at)));
  assert.equal(global.filter(r=>r.status==='fulfilled').length,90);
  assert.equal([...db.rows.values()].filter(r=>r.pk==='ERRORS').length,100);
});
