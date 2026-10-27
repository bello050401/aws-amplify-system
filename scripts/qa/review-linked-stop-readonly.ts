import {fromIni} from '@aws-sdk/credential-providers';
import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {EconveniCredentialStore} from '../../lib/listing/econveni/credentials';
import {EconveniHttpSession} from '../../lib/listing/econveni/httpSession';
import {EconveniWorkflowStore} from '../../lib/listing/econveni/workflowStore';
import {withEconveniAccount} from '../../lib/listing/econveni/accountWorkflow';
async function main(){
 const credentials=fromIni({profile:'Bello'}),region='us-west-2',table='BelloEconveniWorkflow';
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region,credentials}));
 const target=process.argv[2];if(!target)throw Error('Provide existing BASE ID');
 const scan=await db.send(new ScanCommand({TableName:table,FilterExpression:'begins_with(pk,:p)',ExpressionAttributeValues:{':p':'ECONVENI#MANUAL_LINK#'}}));
 const matches=(scan.Items??[]).filter(r=>!r.disabled&&r.baseline?.BASE?.listingId===target);
 if(matches.length!==1||scan.LastEvaluatedKey)throw Error('Unique binding not proven');
 const link=matches[0],store=new EconveniWorkflowStore(link.inventoryId,db,table);
 const secrets=new EconveniCredentialStore(new SecretsManagerClient({region,credentials}));
 let requests=0;
 const session=new EconveniHttpSession(async(input,init)=>{
  const url=new URL(String(input));
  // Any listing write endpoint, even GET commands, is forbidden by this verification harness.
  if(/yahoo_cancel|yahoo_submit|DeleteProduct|CreateProduct|functions\.php/.test(url.pathname))throw Error('WRITE_FORBIDDEN');
  requests++;return fetch(input,init);
 });
 await withEconveniAccount(store,session,()=>secrets.credentials(),async()=>{
  const remote=await session.readExternalProduct(link.productId);
  console.log(JSON.stringify({inventoryId:link.inventoryId,productId:link.productId,title:remote.title,baseline:link.baseline,current:remote.channels,externalWrites:0}));
  if(remote.channels.BASE.listingId!==target||remote.channels.MERCARI_SHOPS.listingId!==link.baseline.MERCARI_SHOPS.listingId)throw Error('Target IDs differ');
  const preview=await session.manualStopPreview(link.productId,'MERCARI_SHOPS');
  console.log(JSON.stringify({inventoryId:link.inventoryId,productId:link.productId,title:remote.title,channels:remote.channels,preview:{channel:preview.channel,operation:preview.operation,productId:preview.productId,title:preview.title,price:preview.price,endpoint:new URL(preview.url).pathname},requests,externalWrites:0}));
 });
}
main().catch(e=>{console.error(e instanceof Error?e.message:'READ_FAILED');process.exitCode=1;});
