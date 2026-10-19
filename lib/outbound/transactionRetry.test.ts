import test from 'node:test';
import assert from 'node:assert/strict';
import {TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {sendOutboundTransaction} from './transactionRetry';
const command=new TransactWriteCommand({TransactItems:[]});
test('transaction collision retries the identical transaction and succeeds',async()=>{let calls=0;const db={send:async(c:unknown)=>{assert.equal(c,command);if(++calls<3)throw Object.assign(new Error('collision'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'None'},{Code:'TransactionConflict'}]});return {ok:true};}};assert.deepEqual(await sendOutboundTransaction(db as unknown as Parameters<typeof sendOutboundTransaction>[0],command),{ok:true});assert.equal(calls,3);});
test('business conditions never retry even with a simultaneous collision',async()=>{let calls=0;const failure=Object.assign(new Error('changed'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'ConditionalCheckFailed'},{Code:'TransactionConflict'}]});await assert.rejects(()=>sendOutboundTransaction({send:async()=>{calls++;throw failure;}} as unknown as Parameters<typeof sendOutboundTransaction>[0],command),e=>e===failure);assert.equal(calls,1);});
test('unknown write outcome is not blindly retried',async()=>{let calls=0;await assert.rejects(()=>sendOutboundTransaction({send:async()=>{calls++;throw Error('network outcome unknown');}} as unknown as Parameters<typeof sendOutboundTransaction>[0],command));assert.equal(calls,1);});
