import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {Agent} from 'node:https';
import {DynamoDBDocumentClient,PutCommand,GetCommand,QueryCommand} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence} from '../lib/inventory/categoryPersistenceCore';
import {moveInventoryHistory,readEditHistory} from '../lib/inventory/reversibleHistory';
import {sendInventoryTransaction} from '../lib/inventory/historyTransaction';

async function main(){
 process.env.AWS_PROFILE='Bello';
 const suffix='BELLO-EditQA-20261109',table=(m:string)=>m+'-'+suffix;
 process.env.INVENTORY_EDIT_JOBS_TABLE=table('InventoryEditJobs');
 process.env.INVENTORY_HISTORY_TABLE=table('Inventory');
 // This Windows test connection resets reused TLS sockets. Fresh connections
 // isolate that local network fault; these timings are NOT Lambda/browser p95.
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2',maxAttempts:6,requestHandler:new NodeHttpHandler({httpsAgent:new Agent({keepAlive:false})})}),{marshallOptions:{removeUndefinedValues:true}}),store=createInventoryPersistence(db,table);
 db.middlewareStack.add((next,context)=>async args=>{try{return await next(args);}catch(error){console.error('AWS operation failed',context.commandName,(error as Error).name);throw error;}},{step:'initialize',name:'safeSoakFailure'});
 const run=randomUUID(),ids=Array.from({length:10},(_,i)=>'SOAK-'+run+'-'+i),samples:Record<string,number[]>={},memory:unknown[]=[],started=Date.now(),duration=Number(process.env.SOAK_MINUTES??30)*60000;
 const read=async(id:string)=>(await db.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item!;
 for(const id of ids)await db.send(new PutCommand({TableName:table('Inventory'),Item:{id,name:'匿名試験',note:'0',categoryIds:[],quantity:5,updatedAt:new Date().toISOString()}}));
 let completed=0,maxHistoryBytes=0,maxReferences=0,error:string|undefined;
 const pct=(a:number[],p:number)=>[...a].sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)];
 const report=()=>{mkdirSync('artifacts/inventory-edit-20261109',{recursive:true});writeFileSync('artifacts/inventory-edit-20261109/aws-soak.json',JSON.stringify({run,environment:'Isolated DynamoDB us-west-2, client Windows/Japan; excludes browser and SQS dispatch',elapsedMs:Date.now()-started,requiredMs:duration,completed,maxHistoryBytes,maxReferences,error,memory,metrics:Object.fromEntries(Object.entries(samples).map(([key,a])=>[key,{n:a.length,p50:pct(a,.5),p95:pct(a,.95),p99:pct(a,.99)}]))},null,2));};
 try{
  while(Date.now()-started<duration){
   const ratio=(Date.now()-started)/duration,concurrency=ratio<1/3?1:ratio<2/3?5:10;
   await Promise.all(ids.slice(0,concurrency).map(async(id,index)=>{
    const t=performance.now(),before=await read(id),state=readEditHistory(before),step=(completed+index)%4;
    const direction=step===1&&state.cursor?'undo':step===2&&state.cursor<state.entries.length?'redo':null;
    if(direction){
     const result=moveInventoryHistory(before,direction),stamp=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString();
     await sendInventoryTransaction(db,{TransactItems:[{Update:{TableName:table('Inventory'),Key:{id},UpdateExpression:'SET #n=:n,#note=:note,updatedAt=:t',ExpressionAttributeNames:{'#n':'name','#note':'note'},ExpressionAttributeValues:{':n':result.row.name,':note':result.row.note,':t':stamp}}}]},{source:direction,operationId:randomUUID(),before:new Map([[id,before]]),restore:new Map([[id,{state:result.state,revision:Number(result.row.revision)}]])});
    }else await store.persistInventoryWithCategories({id,note:String(completed+index+1),name:'匿名試験'+(completed+index)},before.updatedAt);
    const after=await read(id),history=readEditHistory(after);
    assert.equal(after.quantity,5);assert.equal(after.revision,Number(before.revision??0)+1);assert(history.entries.length<=2);assert(history.cursor>=0&&history.cursor<=history.entries.length);
    for(const entry of history.entries){const ref=await db.send(new GetCommand({TableName:table('InventoryEditJobs'),Key:{pk:'OP#'+entry.operationId,sk:'REF#'+id},ConsistentRead:true}));assert(ref.Item,'retained delta must have a live reference');}
    for(const entry of state.entries.filter(e=>!history.entries.some(h=>h.operationId===e.operationId))){const ref=await db.send(new GetCommand({TableName:table('InventoryEditJobs'),Key:{pk:'OP#'+entry.operationId,sk:'REF#'+id},ConsistentRead:true}));assert(!ref.Item,'evicted delta reference must be removed');}
    maxReferences=Math.max(maxReferences,history.entries.length);maxHistoryBytes=Math.max(maxHistoryBytes,Buffer.byteLength(JSON.stringify(history)));
    (samples[`${concurrency}users:${direction??'save'}`]??=[]).push(performance.now()-t);
   }));completed+=concurrency;
   if(completed%50<concurrency){memory.push({elapsedMs:Date.now()-started,completed,...process.memoryUsage(),cpu:process.cpuUsage()});report();console.log(JSON.stringify({elapsedSeconds:Math.round((Date.now()-started)/1000),completed,concurrency,maxHistoryBytes}));}
  }
 }catch(cause){error=cause instanceof Error?cause.message:'test failed';throw cause;}finally{report();}
 console.log('PASS 30-minute mixed saves/undo/redo; history and reference bounds held');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
