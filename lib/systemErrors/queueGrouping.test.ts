import test from 'node:test';
import assert from 'node:assert/strict';
import { systemErrorCauseId } from './cause';
import { SystemErrorQueue } from './queue';
import type { SystemErrorSignal } from './contract';

const signal: SystemErrorSignal = {code:'FEATURE_OPERATION_FAILED',surface:'server',component:'inventory-search',operation:'search',errorClass:'TypeError',check:'operation-failed'};

class AtomicQueueFixture {
  rows = new Map<string, any>();
  key(value: any) { return `${value.pk}|${value.sk}`; }
  async send(command: any) {
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return {Item:this.rows.get(this.key(input.Key))};
    if (command.constructor.name !== 'TransactWriteCommand') throw Error('UNEXPECTED_TEST_OPERATION');
    for (const item of input.TransactItems) {
      if (item.Put && this.rows.has(this.key(item.Put.Item))) throw Object.assign(Error('duplicate'),{name:'TransactionCanceledException'});
      if (item.Update && (this.rows.get(this.key(item.Update.Key))?.count || 0) >= item.Update.ExpressionAttributeValues[':max']) throw Object.assign(Error('budget'),{name:'TransactionCanceledException'});
    }
    for (const item of input.TransactItems) {
      if (item.Put) this.rows.set(this.key(item.Put.Item),structuredClone(item.Put.Item));
      if (item.Update) {const key=this.key(item.Update.Key);this.rows.set(key,{...item.Update.Key,count:(this.rows.get(key)?.count || 0)+1});}
    }
    return {};
  }
}

test('same cause across a calendar rollover and multiple users enqueues one repair', async () => {
  const db = new AtomicQueueFixture();
  const queue = new SystemErrorQueue({table:'ErrorQueue',region:'us-west-2',release:'abcdef123'},db as never);
  const before=Date.parse('2026-11-23T23:59:59Z'),after=Date.parse('2026-11-24T00:00:01Z');
  assert.deepEqual(await queue.enqueue(signal,'one-user',before),{accepted:true,duplicate:false});
  const duplicates=await Promise.all(Array.from({length:50},(_,i)=>queue.enqueue(signal,`other-user-${i}`,after)));
  assert.equal(duplicates.every(result=>result.accepted&&result.duplicate),true);
  assert.equal([...db.rows.values()].filter(row=>row.pk==='ERRORS').length,1);
  assert.equal([...db.rows.values()].filter(row=>String(row.pk).startsWith('BUDGET#')).every(row=>row.count===1),true);
});

test('a new release or a different symptom remains a separate incident', async () => {
  const db=new AtomicQueueFixture(),config={table:'ErrorQueue',region:'us-west-2',release:'abcdef123'};
  const oldQueue=new SystemErrorQueue(config,db as never),newQueue=new SystemErrorQueue({...config,release:'abcdef124'},db as never);
  const now=Date.parse('2026-11-24T00:00:01Z');
  await oldQueue.enqueue(signal,'user',now);
  await newQueue.enqueue(signal,'user',now);
  await oldQueue.enqueue({...signal,code:'FEATURE_INVARIANT_FAILED',check:'filter-result-mismatch'},'user',now);
  assert.equal([...db.rows.values()].filter(row=>row.pk==='ERRORS').length,3);
});

test('group identity ignores payload order and untrusted extras but preserves diagnostic distinctions', () => {
  const reordered={check:'operation-failed',errorClass:'TypeError',operation:'search',component:'inventory-search',surface:'server',code:'FEATURE_OPERATION_FAILED',message:'private customer data'};
  assert.equal(systemErrorCauseId(reordered as SystemErrorSignal,'abcdef123'),systemErrorCauseId(signal,'abcdef123'));
  assert.notEqual(systemErrorCauseId({...signal,errorClass:'RangeError'},'abcdef123'),systemErrorCauseId(signal,'abcdef123'));
  assert.throws(()=>systemErrorCauseId(signal,'private URL or instruction'),/INVALID_SIGNAL/);
});
