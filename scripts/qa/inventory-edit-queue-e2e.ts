// Real SQS -> production worker code -> isolated DynamoDB. No EC/sync writes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildSync} from 'esbuild';
import JSZip from 'jszip';
import {IAMClient,CreateRoleCommand,PutRolePolicyCommand,DeleteRolePolicyCommand,DeleteRoleCommand} from '@aws-sdk/client-iam';
import {LambdaClient,CreateFunctionCommand,waitUntilFunctionActiveV2,CreateEventSourceMappingCommand,DeleteEventSourceMappingCommand,DeleteFunctionCommand,GetEventSourceMappingCommand} from '@aws-sdk/client-lambda';
import {SQSClient,CreateQueueCommand,GetQueueAttributesCommand,SendMessageCommand,DeleteQueueCommand} from '@aws-sdk/client-sqs';
import {CognitoIdentityProviderClient,ListUsersInGroupCommand} from '@aws-sdk/client-cognito-identity-provider';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {Agent} from 'node:https';
import outputs from '../../amplify_outputs.json';
import {createInventoryEditJobs} from '../../lib/inventory/editJobsCore';
import {readEditHistory} from '../../lib/inventory/reversibleHistory';
async function main(){
const config={region:'us-west-2',credentials:fromIni({profile:'Bello'}),requestHandler:new NodeHttpHandler({httpsAgent:new Agent({keepAlive:false})})};
const iam=new IAMClient(config),lambda=new LambdaClient(config),sqs=new SQSClient(config),users=new CognitoIdentityProviderClient(config),db=DynamoDBDocumentClient.from(new DynamoDBClient(config),{marshallOptions:{removeUndefinedValues:true}});
const name='BelloInventoryEditQueueQA20261109',table=(model:string)=>model+'-BELLO-EditQA-20261109',dir=resolve('artifacts/inventory-edit-20261109/queue');mkdirSync(dir,{recursive:true});
process.env.INVENTORY_EDIT_JOBS_TABLE=table('InventoryEditJobs');process.env.INVENTORY_HISTORY_TABLE=table('Inventory');
let queueUrl='',functionCreated=false,roleCreated=false,mapping='';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const members=await users.send(new ListUsersInGroupCommand({UserPoolId:outputs.auth.user_pool_id,GroupName:'ADMIN',Limit:20}));
 const account=members.Users?.find(user=>user.Enabled);assert(account?.Username,'No existing enabled administrator');
 const owner=account.Username; // Never output account details or include them in the report.
 const q=await sqs.send(new CreateQueueCommand({QueueName:name,Attributes:{VisibilityTimeout:'180',MessageRetentionPeriod:'86400'},tags:{Purpose:'isolated-inventory-edit-test'}}));queueUrl=q.QueueUrl!;
 const attr=await sqs.send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['QueueArn']}));const queueArn=attr.Attributes!.QueueArn!;
 const role=await iam.send(new CreateRoleCommand({RoleName:name,AssumeRolePolicyDocument:JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]}),Tags:[{Key:'Purpose',Value:'isolated-inventory-edit-test'}]}));roleCreated=true;
 const arn=(n:string)=>'arn:aws:dynamodb:us-west-2:203918843421:table/'+table(n);
 await iam.send(new PutRolePolicyCommand({RoleName:name,PolicyName:'IsolatedQueueOnly',PolicyDocument:JSON.stringify({Version:'2012-10-17',Statement:[
 {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:BatchWriteItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query','dynamodb:ConditionCheckItem'],Resource:['Inventory','InventoryCategory','Category','InventoryEditJobs'].map(arn)},
 {Effect:'Allow',Action:['cognito-idp:AdminGetUser','cognito-idp:AdminListGroupsForUser'],Resource:'arn:aws:cognito-idp:us-west-2:203918843421:userpool/'+outputs.auth.user_pool_id},
 {Effect:'Allow',Action:['sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes','sqs:SendMessage','sqs:ChangeMessageVisibility'],Resource:queueArn}
 ]})}));
 buildSync({entryPoints:['amplify/functions/inventory-edit-worker/handler.ts'],outfile:resolve(dir,'index.js'),bundle:true,platform:'node',target:'node22',format:'cjs'});
 const archive=new JSZip();archive.file('index.js',readFileSync(resolve(dir,'index.js')));writeFileSync(resolve(dir,'worker.zip'),await archive.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 for(let attempt=0;;attempt++){try{await lambda.send(new CreateFunctionCommand({FunctionName:name,Role:role.Role!.Arn!,Runtime:'nodejs22.x',Handler:'index.handler',Timeout:30,MemorySize:512,Code:{ZipFile:readFileSync(resolve(dir,'worker.zip'))},Environment:{Variables:{INVENTORY_EDIT_JOBS_TABLE:table('InventoryEditJobs'),INVENTORY_HISTORY_TABLE:table('Inventory'),INVENTORY_EDIT_QUEUE_URL:queueUrl,USER_POOL_ID:outputs.auth.user_pool_id,...Object.fromEntries(['Inventory','InventoryCategory','Category'].map(n=>[n+'_TABLE',table(n)]))}},Tags:{Purpose:'isolated-inventory-edit-test'}}));functionCreated=true;break;}catch(error){if(attempt>=8||(error as Error).name!=='InvalidParameterValueException')throw error;await pause(3000);}}
 await waitUntilFunctionActiveV2({client:lambda,maxWaitTime:90},{FunctionName:name});
 const map=await lambda.send(new CreateEventSourceMappingCommand({FunctionName:name,EventSourceArn:queueArn,BatchSize:1,FunctionResponseTypes:['ReportBatchItemFailures'],Enabled:true}));mapping=map.UUID!;
 const runtime=createInventoryEditJobs({db,table,jobsTable:table('InventoryEditJobs'),enqueue:async id=>{await sqs.send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify({id})}));},readBatch:async ids=>{const value=await db.send(new BatchGetCommand({RequestItems:{[table('Inventory')]:{Keys:ids.map(id=>({id})),ConsistentRead:true}}}));return new Map((value.Responses?.[table('Inventory')]??[]).map(row=>[row.id,row]));}});
 const item=randomUUID(),stamp=new Date().toISOString();await db.send(new PutCommand({TableName:table('Inventory'),Item:{id:item,name:'キュー検証チェア',quantity:5,categoryIds:['selling'],categoryId:'selling',updatedAt:stamp}}));
 await db.send(new PutCommand({TableName:table('InventoryCategory'),Item:{id:item+':selling',inventoryId:item,categoryId:'selling'}}));
 const result=[];
 const waitState=async(id:string,state:string)=>{const start=performance.now();for(let n=0;n<120;n++){const value=await runtime.status(id,owner);if(value.job.state===state)return {value,ms:performance.now()-start};if(value.job.state==='FAILED')throw Error('Worker failed');await pause(500);}throw Error('Queue timeout');};
 for(const mode of ['edit','undo','redo'] as const){const id=randomUUID();await runtime.create({id,ids:[item],mode,...(mode==='edit'?{rules:{categories:{mode:'modify' as const,add:['check'],remove:[]},names:[{kind:'prefix' as const,text:'【確認】',skipExisting:true}]}}:{})},owner,owner);const prepared=await waitState(id,'READY');assert.equal(prepared.value.job.counts.CHANGE,1);await runtime.apply(id,owner);const done=await waitState(id,'DONE');assert.equal(done.value.job.counts.SAVED,1);const row=(await db.send(new GetCommand({TableName:table('Inventory'),Key:{id:item},ConsistentRead:true}))).Item!;assert.equal(row.quantity,5);assert.equal(row.name,mode==='undo'?'キュー検証チェア':'【確認】キュー検証チェア');assert.equal(readEditHistory(row).entries.length,1);result.push({mode,previewMs:prepared.ms,applyMs:done.ms,revision:row.revision,status:'PASS'});console.log('PASS actual SQS worker '+mode);}
 writeFileSync(resolve(dir,'results.json'),JSON.stringify({scope:'Actual SQS and production worker with live Cognito role validation; isolated inventory only',result},null,2));
}finally{
 if(mapping){await lambda.send(new DeleteEventSourceMappingCommand({UUID:mapping}));for(let n=0;n<30;n++){try{await lambda.send(new GetEventSourceMappingCommand({UUID:mapping}));await pause(1000);}catch(error){if((error as Error).name==='ResourceNotFoundException')break;throw error;}}}
 if(functionCreated)await lambda.send(new DeleteFunctionCommand({FunctionName:name}));
 if(queueUrl)await sqs.send(new DeleteQueueCommand({QueueUrl:queueUrl}));
 if(roleCreated){await iam.send(new DeleteRolePolicyCommand({RoleName:name,PolicyName:'IsolatedQueueOnly'}));await iam.send(new DeleteRoleCommand({RoleName:name}));}
 console.log('Temporary queue/function/role removed');
}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Test failed');process.exitCode=1;});
