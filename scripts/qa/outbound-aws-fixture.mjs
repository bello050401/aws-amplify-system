/** Real DynamoDB validation on disposable, isolated tables. No transport/S3 writes. */
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
import {randomUUID} from 'node:crypto';
import https from 'node:https';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {createOutboundFixture} from './outbound-preserve-fixture.mjs';

export async function createAwsOutboundFixture(){
 const prefix='bello-qa-outbound-'+randomUUID().slice(0,8)+'-';
 const models=['Inventory','OutboundDestination','Category','Location','InventoryCategory','OutboundBatch','OutboundItem','OutboundSequence','InventoryHistory'];
 const names=new Map(models.map(m=>[m,prefix+m])),created=[];
 const client=new DynamoDBClient({region:'us-west-2',endpoint:'https://dynamodb.us-west-2.amazonaws.com',accountIdEndpointMode:'disabled',credentials:fromIni({profile:'Bello'}),maxAttempts:2,requestHandler:new NodeHttpHandler({httpsAgent:new https.Agent({keepAlive:false,maxSockets:10}),connectionTimeout:10000,requestTimeout:10000,throwOnRequestTimeout:true})});
 const doc=DynamoDBDocumentClient.from(client,{marshallOptions:{removeUndefinedValues:true}});
 let failDispatchOnce=false;
 const database={send:async command=>{
  const input=structuredClone(command.input);
  // These isolated masters have exactly the seeded keys. The workstation's
  // unfiltered master Scan requests time out, so read those real AWS records
  // by key for transaction tests. Public UI separately checks master listing.
  if(command instanceof ScanCommand&&['Category','Location'].includes(input.TableName)){
   const keys=input.TableName==='Category'?['sale','move']:['office','kawagoe'];
   const Items=[];for(const id of keys){const result=await doc.send(new GetCommand({TableName:names.get(input.TableName),Key:{id},ConsistentRead:true}));if(result.Item)Items.push(result.Item);}
   return {Items};
  }
  const map=op=>{if(!names.has(op.TableName))throw Error('Unapproved QA table '+op.TableName);op.TableName=names.get(op.TableName);};
  if(input.TransactItems){
   if(failDispatchOnce&&input.TransactItems.some(a=>a.Put?.TableName==='InventoryHistory')){failDispatchOnce=false;throw Error('Injected dispatch interruption');}
   input.TransactItems.forEach(a=>map(Object.values(a)[0]));
  }else map(input);
  if(process.env.BELLO_QA_TRACE)console.log('AWS QA:',command.constructor.name,input.TableName??'transaction');
  try{return await doc.send(new command.constructor(input));}catch(error){console.error('AWS QA command failed:',command.constructor.name,input.TableName??'transaction',error.name);throw error;}
 }};
 async function cleanup(){
  for(const name of created){if(!name.startsWith(prefix))throw Error('QA cleanup scope mismatch');await client.send(new DeleteTableCommand({TableName:name}));}
  console.log('Isolated QA tables removed: '+created.length);
 }
 try{
  await Promise.all(models.map(async model=>{const name=names.get(model);await client.send(new CreateTableCommand({TableName:name,AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],KeySchema:[{AttributeName:'id',KeyType:'HASH'}],BillingMode:'PAY_PER_REQUEST',Tags:[{Key:'Purpose',Value:'temporary-outbound-regression-test'}]}));created.push(name);await waitUntilTableExists({client,maxWaitTime:60,minDelay:1,maxDelay:3},{TableName:name});}));
  const fixture=createOutboundFixture({database,onError:(...args)=>console.error(...args)});
  await fixture.seed();
  return {...fixture,database,cleanup,prefix,failNextDispatch(){failDispatchOnce=true;},readCloud:async(model,id)=>(await database.send(new GetCommand({TableName:model,Key:{id},ConsistentRead:true}))).Item,scanCloud:async model=>(await database.send(new ScanCommand({TableName:model,ConsistentRead:true}))).Items??[]};
 }catch(error){await cleanup();throw error;}
}
