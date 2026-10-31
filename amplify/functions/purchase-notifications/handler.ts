import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {importPurchases} from '../../../lib/saleCandidates/importer';
import {importBaseOrdersCore} from '../../../lib/saleCandidates/baseImportCore';
import {baseAccessToken} from '../../../lib/base/tokenStore';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
export async function handler(){
 const table=process.env.SALE_CANDIDATES_TABLE!;
 const base=await importBaseOrdersCore(db,table,()=>baseAccessToken(db,process.env.BASE_OAUTH_TOKEN_TABLE_NAME!,async()=>{
  const result=await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:'bello/base-app-credentials'}));
  const p=JSON.parse(result.SecretString??'{}');return p.configured&&p.clientId&&p.clientSecret?{clientId:p.clientId,clientSecret:p.clientSecret}:null;
 }));
 const mail=await importPurchases(db,table);
 if(process.env.YAHOO_PAYMENT_FUNCTION)await new LambdaClient({}).send(new InvokeCommand({FunctionName:process.env.YAHOO_PAYMENT_FUNCTION,InvocationType:'Event'}));
 return {...mail,base};
}
