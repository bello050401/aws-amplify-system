// Explicit isolated AWS integration test; no production table or EC transport.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,UpdateCommand,ScanCommand,type DynamoDBDocumentClient as DocumentClient} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createCandidateStore} from '../../lib/saleCandidates/storeCore';
import {candidateKey} from '../../lib/saleCandidates/identity';
import {importBaseOrdersCore} from '../../lib/saleCandidates/baseImportCore';
import type {SaleCandidate} from '../../lib/saleCandidates/model';

async function main(){
 if(process.env.BELLO_AUDIT_SCRATCH!=='1')throw Error('Scratch-test opt-in required');
 const raw=new DynamoDBClient({region:'us-west-2',credentials:fromIni({profile:'Bello'}),maxAttempts:2}),db=DynamoDBDocumentClient.from(raw);
 const table='Bello-QA-CandidateDeletion-'+randomUUID(),passed:string[]=[];
 const report:{startedAt:string;table:string;passed:string[];cleanup?:string;error?:string}={startedAt:new Date().toISOString(),table,passed};
 let created=false;
 const read=async(id:string)=>(await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;
 const check=(s:string)=>{passed.push(s);console.log('PASS',s);};
 try{
  await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],Tags:[{Key:'Purpose',Value:'disposable-system-audit-20261101'}]}));created=true;
  await waitUntilTableExists({client:raw,maxWaitTime:60,minDelay:1,maxDelay:3},{TableName:table});
  const store=createCandidateStore(db,table),now=new Date().toISOString();
  const fixture=(channel:SaleCandidate['channel'],order:string):SaleCandidate=>({id:candidateKey(channel,order,'0'),channel,state:'PENDING',source:'GMAIL',name:'QA_PRIVATE_PAYLOAD',quantity:5,unitPrice:1234,shipping:100,orderTotal:6270,payment:'QA_PAYMENT',orderId:order,identifierType:'ORDER',saleDate:'2026-11-01',createdAt:now,updatedAt:now,receivedAt:now,warnings:[],orderLineCount:1});
  for(const channel of ['BASE','MERCARI','YAHOO','DIRECT'] as const){const row=fixture(channel,'QA-'+channel);await store.put(row);await store.remove(row.id,'qa');const removed=await read(row.id);assert.equal(removed?.name,undefined);assert.equal(removed?.orderId,undefined);assert.equal(removed?.quantity,undefined);assert.equal(removed?.unitPrice,undefined);assert.equal(removed?.state,'DELETED');assert.equal(Object.keys(removed!).length,8);assert.equal(await store.get(row.id),undefined);assert.equal(await store.put(row),false);await store.remove(row.id,'retry');if(channel==='YAHOO')assert.equal(await store.receiveYahoo({...row,yahooStatus:'AWAITING_SHIPMENT'}),'unchanged');check(channel+' content physically absent on consistent read; retry/import cannot resurrect');}
  const result=await importBaseOrdersCore(db,table,async()=>'fixture-token',(async(url:string)=>{assert(!url.includes('/detail/'),'scrubbed BASE order must not be re-read');return Response.json({orders:[{unique_key:'QA-BASE'}]});}) as typeof fetch);assert(result.ok);assert.equal(result.created,0);check('BASE API import respects scrubbed mail order, without a clear-text order ID');
  const race=fixture('MERCARI','QA-RACE');await store.put(race);let first=true;
  const racing={send:async(cmd:any)=>{if(cmd instanceof PutCommand&&cmd.input.Item?.state==='DELETED'&&first){first=false;await db.send(new UpdateCommand({TableName:table,Key:{id:race.id},UpdateExpression:'SET #s=:done',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':done':'DONE'}}));}return db.send(cmd);}} as unknown as DocumentClient;
  await assert.rejects(createCandidateStore(racing,table).remove(race.id,'qa'),{name:'ConditionalCheckFailedException'});assert.equal((await read(race.id))?.state,'DONE');assert.equal((await read(race.id))?.name,race.name);check('real DynamoDB condition rejects stale delete after concurrent sale');
  const legacy=fixture('BASE','QA-LEGACY');await db.send(new PutCommand({TableName:table,Item:{...legacy,state:'DELETED',deletedAt:now,deletedBy:'original',extraUnrecognizedData:'QA_PRIVATE_PAYLOAD'}}));await store.remove(legacy.id,'migration');assert.equal((await read(legacy.id))?.extraUnrecognizedData,undefined);assert.equal((await read(legacy.id))?.deletedBy,'original');check('legacy tombstone cleanup removes unknown payload fields too');
  const rows=(await db.send(new ScanCommand({TableName:table,ConsistentRead:true}))).Items||[];assert(rows.filter(r=>r.state==='DELETED').every(r=>!JSON.stringify(r).includes('QA_PRIVATE')));
 }catch(e){report.error=(e as Error).name;throw e;}
 finally{if(created){assert(table.startsWith('Bello-QA-CandidateDeletion-'));await raw.send(new DeleteTableCommand({TableName:table}));await waitUntilTableNotExists({client:raw,maxWaitTime:60,minDelay:1,maxDelay:3},{TableName:table});report.cleanup='confirmed table no longer exists';}mkdirSync('artifacts/system-audit-20261101',{recursive:true});writeFileSync('artifacts/system-audit-20261101/candidate-deletion-aws.json',JSON.stringify(report,null,2));}
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});
