const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const built=await build({entryPoints:['lib/saleCandidates/postSaleQueue.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'||a.path==='./postSaleQueueCore'?undefined:{path:a.path,external:true});}}]});
 const make=k=>class{constructor(input){this.input=input;this.kind=k;}};
 let plan,job,transactions,wakes,mode,candidateState;
 const reset=()=>{plan={id:'c',candidateId:'c',sourceId:'i',actor:'staff',token:'t',state:'REVIEW',expiresAt:Date.now()+600000,rows:[{channel:'BASE',operation:'STOCK',state:'READY'}]};job=undefined;transactions=0;wakes=0;mode='normal';candidateState='DONE';};
 const db={send:async c=>{
  if(c.kind==='GetCommand')return {Item:structuredClone(plan)};
  if(c.kind!=='TransactWriteCommand')throw Error('Unexpected DB operation');
  const [update,put]=c.input.TransactItems;
  assert.equal(update.Update.ConditionExpression,'#s=:review AND #t=:token AND actor=:actor AND expiresAt>=:time');
  assert.match(put.Put.ConditionExpression,/attribute_not_exists\(id\).*#s<>:active/);
  // Actual deployed ByState key schema is (state, receivedAt); missing sort key makes a job invisible.
  assert.equal(put.Put.Item.receivedAt,put.Put.Item.createdAt);assert(Number.isFinite(Date.parse(put.Put.Item.receivedAt)));
  if(mode==='fail-before')throw Error('DB unavailable');
  if(plan.state!=='REVIEW'||job?.state==='SALE_EC_ACTIVE')throw Error('Transaction cancelled');
  // The mock commits both records together, as required by TransactWriteItems.
  plan={...plan,state:'QUEUED',queuedAt:put.Put.Item.createdAt};job=structuredClone(put.Put.Item);transactions++;
  if(mode==='lost-ack')throw Error('Connection closed after commit');
  return {};
 }};
 const modules={'server-only':{},'@aws-sdk/lib-dynamodb':Object.fromEntries(['GetCommand','BatchGetCommand','TransactWriteCommand'].map(k=>[k,make(k)])),
  '@aws-sdk/client-lambda':{InvokeCommand:make('InvokeCommand'),LambdaClient:class{async send(){wakes++;throw Error('Wake unavailable');}}},
  '../../amplify_outputs.json':{custom:{saleAutomation:{functionName:'fixture'}}},
  '../listing/econveni/runtimeStore':{econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'plans'},
  './store':{candidateStore:()=>({get:async()=>({state:candidateState,result:{sourceId:'i'}})}),candidateConfig:()=>({tableName:'jobs'})},
  './postSaleCore':{PostSaleError:class extends Error{}}
 };
 const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in modules))throw Error('Unexpected dependency '+k);return modules[k];},Date,Buffer,AbortSignal,process:{env:{}},console:{warn:()=>{}}});
 const enqueue=()=>module.exports.enqueuePostSale('c','staff','t',true,false);
 reset();const result=await enqueue();assert.equal(result.state,'QUEUED');assert.equal(job.state,'SALE_EC_ACTIVE');assert.equal(wakes,1);assert.equal(transactions,1);
 // A failed wake still has a durable job for the existing minute schedule.
 await enqueue();assert.equal(transactions,1);assert.equal(wakes,1);
 reset();mode='fail-before';await assert.rejects(enqueue);assert.equal(plan.state,'REVIEW');assert.equal(job,undefined);assert.equal(wakes,0);
 reset();mode='lost-ack';assert.equal((await enqueue()).state,'QUEUED');await enqueue();assert.equal(transactions,1);assert.equal(wakes,0);
 reset();const both=await Promise.all([enqueue(),enqueue()]);assert(both.every(x=>x.state==='QUEUED'));assert.equal(transactions,1);
 reset();candidateState='PENDING';await assert.rejects(enqueue);assert.equal(transactions,0);
 console.log('PASS: atomic enqueue; failed transaction; lost acknowledgement; concurrent confirmation; no duplicate job; failed wake recovered by schedule; uncommitted sale rejected.');
})().catch(e=>{console.error(e);process.exitCode=1;});
