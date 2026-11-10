import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {CognitoIdentityProviderClient,AdminGetUserCommand,AdminListGroupsForUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {SQSClient,SendMessageCommand} from '@aws-sdk/client-sqs';
import {S3Client} from '@aws-sdk/client-s3';
import {verifyHistoryImageObjects} from '../../../lib/inventory/historyImageGuard';
import {createInventoryEditJobs} from '../../../lib/inventory/editJobsCore';
import {readInventoryCustomDefinitions} from '../../../lib/inventory/customDefinitionRead';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
const table=(name:string)=>{const value=process.env[name+'_TABLE'];if(!value)throw Error('Inventory edit table missing');return value;};
const users=new CognitoIdentityProviderClient({});
const queue=new SQSClient({});
const images=new S3Client({});
const runtime=createInventoryEditJobs({db,table,jobsTable:process.env.INVENTORY_EDIT_JOBS_TABLE!,enqueue:async()=>{throw Error('Worker cannot enqueue new edits');},
 loadCustomDefinitions:()=>readInventoryCustomDefinitions(db,table('CustomFieldDefinition')),
 verifyRestoredImages:(before,after)=>verifyHistoryImageObjects(images,process.env.INVENTORY_BUCKET!,before,after),
 authorizeWorker:async owner=>{const input={UserPoolId:process.env.USER_POOL_ID!,Username:owner};const [user,groups]=await Promise.all([users.send(new AdminGetUserCommand(input)),users.send(new AdminListGroupsForUserCommand(input))]);return user.Enabled===true&&Boolean(groups.Groups?.some(g=>g.GroupName==='ADMIN'||g.GroupName==='EDITOR'));},
 readBatch:async ids=>{const found=new Map<string,Record<string,unknown>>();for(let offset=0;offset<ids.length;offset+=100){let keys=ids.slice(offset,offset+100).map(id=>({id}));for(let attempt=0;keys.length;attempt++){if(attempt>=5)throw Error('BATCH_READ_INCOMPLETE');const r=await db.send(new BatchGetCommand({RequestItems:{[table('Inventory')]:{Keys:keys,ConsistentRead:true}}}));for(const row of r.Responses?.[table('Inventory')]??[])found.set(String(row.id),row);keys=(r.UnprocessedKeys?.[table('Inventory')]?.Keys??[]) as {id:string}[];if(keys.length)await new Promise(resolve=>setTimeout(resolve,50*2**attempt));}}return found;}
});
export async function handler(event:{Records:{messageId:string;body:string;attributes?:{ApproximateReceiveCount?:string}}[]},context?:{getRemainingTimeInMillis:()=>number}){
 const failures:{itemIdentifier:string}[]=[];
 for(const record of event.Records){
  let id:string|undefined;
  try{id=JSON.parse(record.body).id;const result=await runtime.run(id!,()=>Boolean(context&&context.getRemainingTimeInMillis()<20000));
   if(['PREPARING','APPLYING'].includes(result.state))await queue.send(new SendMessageCommand({QueueUrl:process.env.INVENTORY_EDIT_QUEUE_URL!,MessageBody:JSON.stringify({id})}));}
  catch{if(id&&Number(record.attributes?.ApproximateReceiveCount??0)>=4)await runtime.failRun(id).catch(()=>{});failures.push({itemIdentifier:record.messageId});}
 }
 // The queue's dead-letter alarm receives exhausted failures; logs contain no
 // product names, notes, credentials or incoming request bodies.
 return {batchItemFailures:failures};
}
