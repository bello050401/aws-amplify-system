const fs=require('node:fs');
const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,GetCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {LambdaClient,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const {AmplifyClient,GetAppCommand}=require('@aws-sdk/client-amplify');
(async()=>{
 const region='us-west-2',fn='amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm';
 const [config,app]=await Promise.all([new LambdaClient({region}).send(new GetFunctionConfigurationCommand({FunctionName:fn})),new AmplifyClient({region}).send(new GetAppCommand({appId:'d4hkkg7dty2du'}))]);
 if(app.app.environmentVariables?.INQUIRY_CUSTOMER_DELIVERY_ENABLED==='true'||config.Environment.Variables.INQUIRY_CUSTOMER_DELIVERY_ENABLED==='true')throw Error('DELIVERY_MUST_REMAIN_DISABLED');
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region})),TableName=config.Environment.Variables.INQUIRY_TABLE,Key={pk:'CONFIG',sk:'STATE'};
 const before=(await db.send(new GetCommand({TableName,Key,ConsistentRead:true}))).Item;
 if(before?.delivery?.mode&&!['DRAFT'].includes(before.delivery.mode))throw Error('CONFIG_CHANGED');
 if(before?.mercariShopId&&before.mercariShopId!=='evkhihBFFNn5hukMS9s36H')throw Error('ACCOUNT_CHANGED');
 fs.writeFileSync('artifacts/whole-instruction-20261107/config-before-reader-private.json',JSON.stringify(before));
 await db.send(new UpdateCommand({TableName,Key,UpdateExpression:'SET mercariShopId=:shop,delivery=if_not_exists(delivery,:draft)',ExpressionAttributeValues:{':shop':'evkhihBFFNn5hukMS9s36H',':draft':{mode:'DRAFT',approvedIntents:[]}}}));
 const after=(await db.send(new GetCommand({TableName,Key,ConsistentRead:true}))).Item;
 console.log(JSON.stringify({readAccountConfigured:after.mercariShopId==='evkhihBFFNn5hukMS9s36H',deliveryMode:after.delivery.mode,enabled:after.enabled,notifyStaff:after.notifyStaff}));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
