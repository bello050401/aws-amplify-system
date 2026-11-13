// Isolated DynamoDB integration. No real stock, e-conveni or notification access.
const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict');
const {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,PutCommand,GetCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
(async()=>{
 const table='BelloQA-CatalogMaintenance-'+Date.now(),raw=new DynamoDBClient({region:'us-west-2'}),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}});let created=false;
 const bundle=async(file,external=false)=>(await build({entryPoints:[file],bundle:true,platform:'node',packages:'external',format:'cjs',write:false,plugins:external?[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]:[]})).outputFiles[0].text;
 const load=(code,ports)=>{const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:k=>ports[k]??require(k),Date,Map,Set,console,process:{env:{SALE_CANDIDATES_TABLE:table}}});return module.exports;};
 try{
  await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'},{AttributeName:'state',AttributeType:'S'},{AttributeName:'receivedAt',AttributeType:'S'}],GlobalSecondaryIndexes:[{IndexName:'ByState',KeySchema:[{AttributeName:'state',KeyType:'HASH'},{AttributeName:'receivedAt',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;await waitUntilTableExists({client:raw,maxWaitTime:50,minDelay:2,maxDelay:3},{TableName:table});
  const fixtures=[['retire','BASE','101',false,true],['first','BASE','102',false,false],['active','MERCARI','103',true,true],['conflict','BASE','104',false,true]];
  for(const [id,channel,externalListingId,selling,observed] of fixtures){await db.send(new PutCommand({TableName:table,Item:{id:'stock-'+id,categoryIds:selling?['selling']:['sold'],updatedAt:'v2'}}));await db.send(new PutCommand({TableName:table,Item:{id,state:'PENDING',channel,externalListingId,updatedAt:'c1',receivedAt:'2026-11-13T00:00:00Z',...(observed?{listingObservation:{inventoryId:'stock-'+id,selling:true,at:'2026-11-12T00:00:00Z',inventoryVersion:'v1'}}:{})}}));}
  await db.send(new PutCommand({TableName:table,Item:{id:'unpaid',state:'DONE',channel:'YAHOO',yahooPaymentState:'WAITING',updatedAt:'c1',receivedAt:'2026-11-13T00:00:00Z'}}));
  await db.send(new PutCommand({TableName:table,Item:{id:'unknown',state:'PENDING',channel:'BASE',externalListingId:'999',updatedAt:'c1',receivedAt:'2026-11-13T00:00:00Z'}}));
  let fault=true,syncFailed=false;const port={send:async command=>{
   if(command.constructor.name==='ScanCommand'){const name=command.input.TableName;return{Items:name==='Category'?[{id:'selling',name:'販売中'}]:name==='ChannelListing'?fixtures.map(([id,channel,externalListingId])=>({inventoryId:'stock-'+id,channel:channel==='MERCARI'?'MERCARI_SHOPS':channel,externalListingId})):[]};}
   if(command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems[1].Update.Key.id==='conflict'&&fault){fault=false;await db.send(new UpdateCommand({TableName:table,Key:{id:'stock-conflict'},UpdateExpression:'SET updatedAt=:v',ExpressionAttributeValues:{':v':'v3'}}));}
   return db.send(command);
  }};
  const policy=load(await bundle('lib/saleCandidates/maintenancePolicy.ts'),{}),categories=load(await bundle('lib/inventory/categories.ts'),{});
  const run=load(await bundle('amplify/functions/sale-automation/maintenance.ts',true),{'../../../lib/inventory/categoryPersistence':{inventoryDdb:port,inventoryTable:n=>n==='Inventory'?table:n},'../../../lib/listing/econveni/manualSync':{refreshManualSync:async()=>{if(syncFailed)throw Error('ECONVENI_FAILED');},readManualSync:async()=>({links:[],snapshot:null})},'../../../lib/listing/econveni/runtimeStore':{readEconveniCatalog:async()=>[]},'../../../lib/inventory/categories':categories,'../../../lib/saleCandidates/maintenancePolicy':policy}).runCatalogMaintenance;
  // GSI is eventually consistent; wait for all five pending fixtures, bounded.
  const {QueryCommand}=require('@aws-sdk/lib-dynamodb');for(let i=0;i<30;i++){const r=await db.send(new QueryCommand({TableName:table,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'PENDING'}}));if(r.Count===5)break;if(i===29)throw Error('FIXTURE_INDEX_NOT_READY');await new Promise(r=>setTimeout(r,300));}
  const result=await run();assert.equal(result.error,'');assert.equal(result.retired,1);assert.equal(result.checked,3);assert.equal(result.conflicts,1);assert.equal(result.unmatched,1);
  const get=async id=>(await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;
  assert.equal((await get('retire')).state,'ARCHIVED');assert.equal((await get('first')).state,'PENDING');assert.equal((await get('active')).listingObservation.selling,true);assert.equal((await get('unpaid')).yahooPaymentState,'WAITING');assert.equal((await get('conflict')).state,'PENDING');
  const retired=await get('retire');const candidateStore=load(await bundle('lib/saleCandidates/storeCore.ts'),{}).createCandidateStore(db,table);assert.equal(await candidateStore.receiveYahoo({...retired,channel:'YAHOO'}),'unchanged');assert.equal(await candidateStore.get('retire'),undefined);
  syncFailed=true;const second=await run();assert.equal(second.econveni,'FAILED');assert(second.error);assert.equal((await get('unpaid')).state,'DONE');assert.equal((await get('retire')).state,'ARCHIVED');
  console.log(JSON.stringify({passed:9,result,cases:['actual transaction expression','observed transition only','first observation retained','Mercari channel mapping','concurrent edit retained','unmatched retained','unpaid DONE retained','mail cannot resurrect archived','sync failure recorded']}));
 }finally{if(created)await raw.send(new DeleteTableCommand({TableName:table}));console.log('QA table removed');}
})().catch(e=>{console.error(e);process.exitCode=1;});
