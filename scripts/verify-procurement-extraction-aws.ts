import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Agent} from 'node:https';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,DescribeTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,UpdateCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {ExtractionRepository,type ExtractionJob} from '../lib/procurement/extraction/jobs';
import {extractDimensions} from '../lib/procurement/extraction/dimensions';
import {descriptionBlocks,sha} from '../lib/procurement/extraction/sources';
import {registeredExtractionPage} from '../lib/procurement/extraction/reviewQueue';
const name='bello-qa-supplier-extraction-'+Date.now(),region='us-west-2',client=new DynamoDBClient({region,maxAttempts:4,requestHandler:new NodeHttpHandler({httpsAgent:new Agent({keepAlive:false}),connectionTimeout:10000,requestTimeout:20000})}),db=DynamoDBDocumentClient.from(client,{marshallOptions:{removeUndefinedValues:true}});
const tables=[name+'-imports',name+'-stock',name+'-history'];const created:string[]=[],checks:string[]=[];
const output='artifacts/procurement-extraction-20261107/aws-transaction-tests.json';
async function main(){
 try{
  for(let i=0;i<tables.length;i++){await client.send(new CreateTableCommand({TableName:tables[i],BillingMode:'PAY_PER_REQUEST',KeySchema:i===0?[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:i===0?[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]:[{AttributeName:'id',AttributeType:'S'}],Tags:[{Key:'Purpose',Value:'supplier-extraction-isolated-qa'}]}));created.push(tables[i]);await waitUntilTableExists({client,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName:tables[i]});}
  const repo=new ExtractionRepository({region,table:tables[0],inventoryTable:tables[1],historyTable:tables[2],bucket:'not-used-in-qa'},db);
  const identity={provider:'YAHOO' as const,account:'BELLO-primary',externalId:'r1234567890',row:'auction',inventoryId:'test'};
  const at='2026-11-07T00:00:00.000Z';
  const row={id:'test',name:'ISOLATED QA',quantity:5,note:'スタッフメモ',updatedAt:at,customFields:JSON.stringify({__yahooPurchaseImport:{auctionId:identity.externalId}})};
  const job:ExtractionJob={pk:'EXTRACTION#test',sk:'CURRENT',identity,revision:'r1',state:'REVIEW',createdAt:at,updatedAt:at,requestedBy:'QA'};
  const result=extractDimensions({identity,url:'https://auctions.yahoo.co.jp/jp/auction/'+identity.externalId,hash:sha('W715mm D760mm H810mm'),acquiredAt:at,format:'yahoo-description-html-v1',complete:true,targetVerified:true,blocks:descriptionBlocks('W715mm D760mm H810mm'),issues:[]});
  const seed=async()=>{await db.send(new PutCommand({TableName:tables[1],Item:row}));await db.send(new PutCommand({TableName:tables[0],Item:job}));};
  const stock=()=>repo.inventory('test');const currentJob=()=>repo.get('test');
  await seed();await repo.apply(job,result,at,'QA');let saved=await stock();assert.equal(saved?.width,'71.5');assert.equal(saved?.depth,'76');assert.equal(saved?.height,'81');assert.equal(saved?.listUpdatedAt,saved?.updatedAt);assert.equal(saved?.quantity,5);assert.equal(saved?.note,'スタッフメモ');assert.equal((await currentJob())?.state,'APPLIED');checks.push('atomic dimensions apply, cm conversion, stock/name/note preserved');
  const before=JSON.stringify(saved);await assert.rejects(()=>repo.apply(job,result,at,'QA'));assert.equal(JSON.stringify(await stock()),before);checks.push('duplicate confirmation rejected; no repeated mutation');
  await seed();await db.send(new UpdateCommand({TableName:tables[1],Key:{id:'test'},UpdateExpression:'SET width=:w, updatedAt=:v',ExpressionAttributeValues:{':w':'99',':v':'2026-11-07T01:00:00.000Z'}}));await assert.rejects(()=>repo.apply(job,result,at,'QA'));assert.equal((await stock())?.width,'99');assert.equal((await currentJob())?.state,'REVIEW');checks.push('concurrent human edit preserved');
  await seed();await db.send(new UpdateCommand({TableName:tables[0],Key:{pk:job.pk,sk:job.sk},UpdateExpression:'SET revision=:r',ExpressionAttributeValues:{':r':'newer-job'}}));await assert.rejects(()=>repo.apply(job,result,at,'QA'));assert.equal((await stock())?.width,undefined);assert.equal((await stock())?.updatedAt,at);checks.push('stale job fails transaction without partial inventory writes');
  await seed();const bad=new ExtractionRepository({...repo.config,historyTable:name+'-missing'},db);await assert.rejects(()=>bad.apply(job,result,at,'QA'));assert.equal((await stock())?.width,undefined);assert.equal((await currentJob())?.state,'REVIEW');checks.push('history failure rolls back inventory and job together');
  await seed();await db.send(new UpdateCommand({TableName:tables[1],Key:{id:'test'},UpdateExpression:'SET outboundBatchId=:b',ExpressionAttributeValues:{':b':'reserved'}}));await assert.rejects(()=>repo.apply(job,result,at,'QA'));assert.equal((await stock())?.width,undefined);checks.push('outbound reservation lock retained');
  await seed();await db.send(new UpdateCommand({TableName:tables[1],Key:{id:'test'},UpdateExpression:'SET customFields=:c',ExpressionAttributeValues:{':c':JSON.stringify({__yahooPurchaseImport:{auctionId:'r9999999999'}})}}));await assert.rejects(()=>repo.apply(job,result,at,'QA'));assert.equal((await stock())?.width,undefined);checks.push('external item identity change prevents cross-product write');
  await seed();const queued=await repo.request(identity,'QA','r1');await assert.rejects(()=>repo.request(identity,'QA','r1'));await repo.claim(queued);await assert.rejects(()=>repo.claim(queued));await assert.rejects(()=>repo.request(identity,'QA',queued.revision));checks.push('duplicate enqueue/claim and in-flight restart prevented');
  await repo.finish(queued,{state:'FAILED',error:'QA'});const retry=await repo.request(identity,'QA',queued.revision);await assert.rejects(()=>repo.finish(queued,{state:'APPLIED'}));assert.equal((await currentJob())?.revision,retry.revision);checks.push('late completion cannot overwrite newer retry');
  await assert.rejects(()=>repo.cache(queued,'hash','old-key'));assert.equal(await repo.cached(identity,'hash'),undefined);await repo.claim(retry);await repo.cache(retry,'hash','new-key');assert.equal(await repo.cached(identity,'hash'),'new-key');checks.push('late source cache update rejected; current revision cache accepted');
  await repo.cancel('test',retry.revision);await assert.rejects(()=>repo.finish(retry,{state:'APPLIED'}));await assert.rejects(()=>repo.cache(retry,'hash','late-key'));assert.equal((await currentJob())?.state,'EXCLUDED');assert.equal((await stock())?.width,undefined);checks.push('cancel rejects late completion and cache without stock changes');
  await db.send(new PutCommand({TableName:tables[0],Item:{pk:'YAHOO_PURCHASE',sk:identity.externalId,status:'REGISTERED',inventoryId:'test'}}));
  await db.send(new PutCommand({TableName:tables[0],Item:{pk:'YAHOO_PURCHASE',sk:'r9999999999',status:'EXCLUDED',inventoryId:'excluded'}}));
  const page=await registeredExtractionPage(repo,'YAHOO','');assert.equal(page.rows.length,1);assert.equal(page.rows[0].id,'test');assert.equal(page.rows[0].job?.state,'EXCLUDED');checks.push('review queue lists registered stock only and attaches exact current job');
  console.log(JSON.stringify({checks:checks.length,passed:checks}));
 }finally{
  const removed:string[]=[],cleanupErrors:string[]=[];
  for(const table of created){if(!table.startsWith(name+'-'))throw Error('Unsafe cleanup target');try{await client.send(new DeleteTableCommand({TableName:table}));await waitUntilTableNotExists({client,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName:table});removed.push(table);}catch(e){cleanupErrors.push(table+': '+(e as Error).name);}}
  fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),checks,created,removed,cleanupErrors,productionDataChanged:false},null,2));
  if(cleanupErrors.length)throw Error('QA cleanup incomplete: '+cleanupErrors.join(', '));
 }
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1});
