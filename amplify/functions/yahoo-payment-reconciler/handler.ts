import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createYahooPaymentReconciler} from '../../../lib/saleCandidates/yahooPaymentReconciler';
import {createYahooPaymentStockPorts} from '../../../lib/saleCandidates/yahooPaymentStock';
import {S3Client} from '@aws-sdk/client-s3';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
export async function handler(){
 const table=(name:string)=>{
  const value=process.env[name+'_TABLE'];if(!value)throw Error('PAYMENT_TABLE_NOT_CONFIGURED');return value;
 };
 const required=(key:string)=>{const value=process.env[key];if(!value)throw Error('PAYMENT_STORAGE_NOT_CONFIGURED');return value;};
 const ports=createYahooPaymentStockPorts({db,table,s3:new S3Client({}),inventoryBucket:required('INVENTORY_BUCKET'),photoTable:required('PHOTO_REGISTRATION_TABLE_NAME'),photoBucket:required('PHOTO_REGISTRATION_BUCKET_NAME'),nextSku:async()=>{
  const r=await new LambdaClient({}).send(new InvokeCommand({FunctionName:required('GENERATE_SKU_FUNCTION_NAME'),Payload:Buffer.from('{}')}));
  const sku=JSON.parse(Buffer.from(r.Payload??[]).toString());if(r.FunctionError||typeof sku!=='string'||!/^B\d+$/.test(sku))throw Error('PAYMENT_SKU_FAILED');return sku;
 }});
 return createYahooPaymentReconciler(db,process.env.SALE_CANDIDATES_TABLE!,table,ports).run();
}
