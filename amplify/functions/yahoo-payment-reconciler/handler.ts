import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createYahooPaymentReconciler} from '../../../lib/saleCandidates/yahooPaymentReconciler';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
export async function handler(){
 return createYahooPaymentReconciler(db,process.env.SALE_CANDIDATES_TABLE!,name=>{
  const value=process.env[name+'_TABLE'];if(!value)throw Error('PAYMENT_TABLE_NOT_CONFIGURED');return value;
 }).run();
}
