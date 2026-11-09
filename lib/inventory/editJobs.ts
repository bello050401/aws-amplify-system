import 'server-only';
import {SQSClient,SendMessageCommand} from '@aws-sdk/client-sqs';
import outputs from '../../amplify_outputs.json';
import {inventoryDdb,inventoryTable} from './categoryPersistence';
import {readInventoryBatch} from './batchRead';
import {createInventoryEditJobs} from './editJobsCore';
type Config={table:string;queueUrl:string;region:string};
export function inventoryEditConfig(){
 const config=(outputs as unknown as {custom?:{inventoryEdits?:Config}}).custom?.inventoryEdits;
 const table=process.env.INVENTORY_EDIT_JOBS_TABLE??config?.table,queueUrl=process.env.INVENTORY_EDIT_QUEUE_URL??config?.queueUrl;
 if(!table||!queueUrl)throw Error('一括編集の準備が完了していません。通常の編集をご利用ください。');
 const region=process.env.AWS_REGION??config?.region??'us-west-2';
 return {table,queueUrl,region};
}
export function inventoryEditRuntime(){
 const {table,queueUrl,region}=inventoryEditConfig();
 return createInventoryEditJobs({db:inventoryDdb,table:inventoryTable,jobsTable:table,readBatch:ids=>readInventoryBatch(inventoryDdb,inventoryTable('Inventory'),ids),
  enqueue:async id=>{await new SQSClient({region}).send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify({id})}));}});
}
