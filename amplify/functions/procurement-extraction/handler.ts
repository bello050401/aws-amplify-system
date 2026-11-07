import type {DynamoDBStreamEvent} from 'aws-lambda';
import {unmarshall} from '@aws-sdk/util-dynamodb';
import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {ExtractionRepository,type ExtractionJob} from '../../../lib/procurement/extraction/jobs';
import {createExtractionAfterImport,processExtraction} from '../../../lib/procurement/extraction/worker';
const required=(key:string)=>{const value=process.env[key];if(!value)throw Error('CONFIGURATION_MISSING');return value;};
export async function handler(event:DynamoDBStreamEvent){
 const repo=new ExtractionRepository({region:required('AWS_REGION'),table:required('IMPORT_TABLE'),bucket:required('SOURCE_BUCKET'),inventoryTable:required('INVENTORY_TABLE'),historyTable:required('HISTORY_TABLE')});
 for(const record of event.Records){
  if(!record.dynamodb?.NewImage)continue;
  const row=unmarshall(record.dynamodb.NewImage as Record<string,AttributeValue>);
  if(row.status==='REGISTERED')await createExtractionAfterImport(repo,row);
  if(row.pk?.startsWith('EXTRACTION#')&&row.sk==='CURRENT'&&row.state==='QUEUED')await processExtraction(repo,row as ExtractionJob,required('RESTAGE_SECRET'));
 }
}
