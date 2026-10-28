import assert from 'node:assert/strict';
import {GetCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {invoiceNumber,reserveInvoiceNumber} from '../lib/invoicing/numbering';
async function main(){
 const counters=new Map<string,number>();
 const db:any={send:async(command:GetCommand|UpdateCommand)=>{
  const i:any=command.input,id=i.Key.id;
  if(command instanceof GetCommand)return {Item:counters.has(id)?{last:counters.get(id)}:undefined};
  const v=i.ExpressionAttributeValues,expected=v[':previous'];
  if(counters.get(id)!==expected)throw Object.assign(new Error(),{name:'ConditionalCheckFailedException'});
  assert.deepEqual(Object.keys(i.ExpressionAttributeNames),['#last']);
  counters.set(id,v[':next']);return {};
 }};
 assert.equal(invoiceNumber('2026-10-25',2),'202610252');
 const reserve=(date='2026-10-25',start=1)=>reserveInvoiceNumber(db,'operations',date,start);
 assert.equal(await reserve(),'202610251');
 assert.equal(await reserve(),'202610252');
 assert.equal(await reserve('2026-10-26'),'202610261');
 assert.equal(await reserve('2026-10-25',8),'202610258');
 assert.equal(await reserve('2026-10-25',2),'202610259');
 const concurrent=await Promise.all(Array.from({length:5},()=>reserve()));
 assert.equal(new Set(concurrent).size,5);assert.equal(await reserve(),'2026102515');
 for(const [date,seq] of [['2026-02-30',1],['2026-10-25',0],['2026-10-25',100000],['2026-10-25',1.5]] as const)assert.throws(()=>invoiceNumber(date,seq));
 counters.set('invoice-number#2026-10-25',99999);await assert.rejects(reserve,/INVALID_NUMBER/);
 console.log('PASS 日ごとの枚数・日付変更・既存番号の続き・並行発行・番号再利用防止・不正値');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
