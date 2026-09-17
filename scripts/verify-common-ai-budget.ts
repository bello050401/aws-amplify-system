import assert from "node:assert/strict";
import { reservePaidAttempt, settlePaidAttempt, readBudgetSummary, type BudgetConfig } from "../lib/ai/gateway/commonBudget";
import type { LedgerDeps } from "../lib/ai/budget/ledgerClient";
let checked = 0;
function check(v: unknown) { assert.ok(v); checked++; }
const config: BudgetConfig = { baselineVerifiedMonth: "2026-09", priorSpentJPY: 0, pricing: [{ providerId: "test", modelId: "synthetic", inputUsdPerMillion: 1, outputUsdPerMillion: 1, yenPerUsdUpperBound: 100, validUntil: "2026-10-01T00:00:00Z" }] };
const rows = new Map<string, any>();
const db = { send: async (cmd: any) => {
 const q = cmd.input;
 if (!q.TransactItems) return { Item: rows.get(q.TableName + ':' + (q.Key.id ?? q.Key.month)) };
 const [r,l] = q.TransactItems; const upd = l.Update; const v = upd.ExpressionAttributeValues; const key = 'AIBudgetLedger:'+upd.Key.month;
 let ledger = rows.get(key);
 if (r.Put) {
  const item=r.Put.Item; const rk='AIBudgetReservation:'+item.id;
  check(upd.ConditionExpression.includes('remaining >= :amount') && upd.ConditionExpression.includes('priorSpent = :prior'));
  check(upd.UpdateExpression.includes('callCount = if_not_exists(callCount, :zero) + :one'));
  if(rows.has(rk) || ledger && (ledger.remaining < item.amount || ledger.cap !== v[':cap'] || ledger.priorSpent !== v[':prior'])) {
   const e:any=new Error('condition');e.CancellationReasons=[{Code:rows.has(rk)?'ConditionalCheckFailed':'None'},{Code:rows.has(rk)?'None':'ConditionalCheckFailed'}];throw e;
  }
  ledger ??= {cap:v[':cap'],remaining:v[':initial'],priorSpent:v[':prior'],spent:v[':prior'],reserved:0,callCount:0};
  ledger.remaining-=item.amount;ledger.reserved+=item.amount;ledger.callCount++;rows.set(rk,{...item});rows.set(key,ledger);return {};
 }
 const rv=r.Update.ExpressionAttributeValues;const rk='AIBudgetReservation:'+r.Update.Key.id;const item=rows.get(rk);
 check(r.Update.ConditionExpression === '#status = :expectedStatus');
 assert.equal(item.status,'RESERVED');item.status=rv[':newStatus'];item.actualAmount=rv[':actualAmount'];ledger.remaining-=v[':delta'];ledger.reserved-=v[':reserved'];ledger.spent+=v[':actual'];return {};
}};
const ledger: LedgerDeps = { ddb: db as any, tableFor: m=>m, now: ()=> '2026-09-16T00:00:00Z' };
const deps={ledger,config,now:new Date('2026-09-16T00:00:00Z')};
const attempt={providerId:'test',modelId:'synthetic',inputTokens:10000,maxOutputTokens:10000}; // 2 JPY worst case
async function main(){
 check(!(await reservePaidAttempt(attempt,{...deps,config:{...config,baselineVerifiedMonth:'2026-08'}})).allowed);
 check(!(await reservePaidAttempt({...attempt,modelId:'unknown'},deps)).allowed);
 check(!(await reservePaidAttempt({...attempt,inputTokens:NaN},deps)).allowed);
 check(!(await reservePaidAttempt(attempt,{...deps,config:{...config,pricing:[{...config.pricing[0],validUntil:'2026-01-01'}]}})).allowed);
 const broken={...ledger,ddb:{send:async()=>{throw new Error('offline')}} as any};
 check(!(await reservePaidAttempt(attempt,{...deps,ledger:broken})).allowed);
 check(!(await reservePaidAttempt(attempt,{...deps,config:{...config,pricing:[{...config.pricing[0],yenPerUsdUpperBound:0}]}})).allowed);
 const results=await Promise.all(Array.from({length:180},(_,i)=>reservePaidAttempt(attempt,{...deps,id:String(i)})));
 assert.equal(results.filter(r=>r.allowed).length,150);checked++;
 let sum=await readBudgetSummary(deps);check(sum.initialized && sum.remainingJPY===0 && sum.reservedJPY===300 && sum.callCount===150);
 const accepted=results[0];assert(accepted.allowed);
 check(!(await reservePaidAttempt(attempt,{...deps,id:'0'})).allowed);
 check(!(await settlePaidAttempt(accepted.reservation,{inputTokens:10000,outputTokens:0},{ledger:broken})));
 check(await settlePaidAttempt(accepted.reservation,{inputTokens:10000,outputTokens:0},{ledger}));
 check(await settlePaidAttempt(accepted.reservation,{inputTokens:10000,outputTokens:0},{ledger})); // idempotent
 sum=await readBudgetSummary(deps);check(sum.initialized && sum.spentJPY===1 && sum.reservedJPY===298 && sum.remainingJPY===1);
 check(!(await settlePaidAttempt(accepted.reservation,{inputTokens:NaN,outputTokens:0},{ledger})));
 // A timed out call is never settled/released; its two yen remain reserved.
 check(!(await reservePaidAttempt(attempt,deps)).allowed);
 check(!(await reservePaidAttempt(attempt,{...deps,now:new Date('2026-10-01')})).allowed);
 rows.clear();
 check(!(await reservePaidAttempt(attempt,{...deps,config:{...config,priorSpentJPY:299}})).allowed);
 check((await reservePaidAttempt(attempt,{...deps,config:{...config,priorSpentJPY:298}})).allowed);
 check(!(await reservePaidAttempt(attempt,{...deps,config:{...config,priorSpentJPY:0}})).allowed);
 console.log(`budget: ${checked} assertions passed (synthetic, no AWS/provider calls)`);
}
main().catch(e=>{console.error(e);process.exitCode=1});
