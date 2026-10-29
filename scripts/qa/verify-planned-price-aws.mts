import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,TransactWriteCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import https from 'node:https';
import {savePlannedPrice,type PriceEntryRecord} from '../../lib/inventory/plannedPriceCore';
import {priceEntryWriteItems} from '../../lib/inventory/plannedPriceWrite';
import {buildCountExpression} from '../../lib/inventory/inventoryCountFast';
const prefix='bello-qa-price-'+randomUUID().slice(0,8)+'-',names=['Inventory','InventoryHistory'],created:string[]=[];
const client=new DynamoDBClient({region:'us-west-2',endpoint:'https://dynamodb.us-west-2.amazonaws.com',accountIdEndpointMode:'disabled',credentials:fromIni({profile:'Bello'}),maxAttempts:1,requestHandler:new NodeHttpHandler({httpsAgent:new https.Agent({keepAlive:false}),requestTimeout:10000,connectionTimeout:10000,throwOnRequestTimeout:true})});
const doc=DynamoDBDocumentClient.from(client,{marshallOptions:{removeUndefinedValues:true}}),table=(n:string)=>{if(!names.includes(n))throw Error('QA scope');return prefix+n;};
try{
 for(const n of names){const name=table(n);await client.send(new CreateTableCommand({TableName:name,AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],KeySchema:[{AttributeName:'id',KeyType:'HASH'}],BillingMode:'PAY_PER_REQUEST'}));created.push(name);await waitUntilTableExists({client,maxWaitTime:45,minDelay:1,maxDelay:2},{TableName:name});}
 const original={id:randomUUID(),sku:'QA',name:'AWS隔離確認',note:'元の備考',categoryIds:['repair'],quantity:5,locationId:'office',updatedAt:'2026-10-29T00:00:00.000Z'};
 await doc.send(new PutCommand({TableName:table('Inventory'),Item:original}));
 const get=async(id:string)=>(await doc.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item as PriceEntryRecord;
 let writes=0;const port={get,categories:async()=>[{id:'repair',name:'補修待ち'}],save:async(before:PriceEntryRecord,patch:Record<string,unknown>,actor:string)=>{await doc.send(new TransactWriteCommand({TransactItems:priceEntryWriteItems(before,patch,actor,table)}));writes++;}};
 const input={id:original.id,expectedUpdatedAt:original.updatedAt,mutationId:randomUUID(),name:'保存確認',note:'価格を入力',plannedSalePrice:43000};
 const saved=await savePlannedPrice(port,input,'QA');assert.equal(saved.plannedSalePrice,43000);assert.equal(saved.quantity,5);assert.deepEqual(saved.categoryIds,['repair']);assert.equal(saved.locationId,'office');
 await savePlannedPrice(port,input,'QA');assert.equal(writes,1);
 await assert.rejects(()=>savePlannedPrice(port,{...input,mutationId:randomUUID(),plannedSalePrice:50},'QA'));
 const rollback={...original,id:randomUUID()};await doc.send(new PutCommand({TableName:table('Inventory'),Item:rollback}));
 const transaction=priceEntryWriteItems(rollback,{plannedSalePrice:100,updatedAt:'2026-10-29T00:00:01.000Z'},'QA',table)!;
 transaction.push({ConditionCheck:{TableName:table('Inventory'),Key:{id:original.id},ConditionExpression:'attribute_not_exists(id)'}});
 await assert.rejects(()=>doc.send(new TransactWriteCommand({TransactItems:transaction})));assert.equal((await get(rollback.id)).plannedSalePrice,undefined);
 // Production filter syntax against the real engine, including zero-price exclusion.
 const filter=buildCountExpression({categoryIds:['repair']});const result=await doc.send(new ScanCommand({TableName:table('Inventory'),FilterExpression:filter.filterExpression+' AND (attribute_not_exists(#price) OR #price = :emptyPrice OR #price = :nullPrice)',ExpressionAttributeNames:{...filter.names,'#price':'plannedSalePrice'},ExpressionAttributeValues:{...filter.values,':emptyPrice':'',':nullPrice':null}}));assert.deepEqual(result.Items?.map(i=>i.id),[rollback.id]);
 console.log('PASS AWS: price/name/note saved, unrelated stock unchanged, duplicate retry and stale write blocked, failed transaction rolled back, production missing-price filter works.');
}finally{for(const name of created){if(!name.startsWith(prefix))throw Error('QA cleanup scope');await client.send(new DeleteTableCommand({TableName:name}));}console.log('QA tables removed: '+created.length);client.destroy();}
