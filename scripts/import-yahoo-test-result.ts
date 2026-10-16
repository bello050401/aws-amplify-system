/** Import only the authorized, verified test result into the staging model.
 * Does not publish, cancel, upload, replace a binding or change inventory stock. */
import {fromIni} from '@aws-sdk/credential-providers';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {DynamoDBClient,GetItemCommand,PutItemCommand} from '@aws-sdk/client-dynamodb';
import {marshall,unmarshall} from '@aws-sdk/util-dynamodb';
import {YahooWebSession} from '../lib/listing/yahooAuction/webHttpSession';
import {parseYahooSaved} from '../lib/listing/yahooAuction/preparation';
import {parseYahooListingResult} from '../lib/listing/yahooAuction/listingResult';
async function main(){
  const config={region:'us-west-2',credentials:fromIni({profile:'Bello'})};
  if((await new STSClient(config).send(new GetCallerIdentityCommand({}))).Account!=='203918843421')throw Error();
  const inventoryId='57b4b2b5-d6ad-435a-b303-5d412405a44c',auctionId='f1248612637';
  const suffix='-j6up24p7lnczdmklzjdt3vrp4y-NONE',db=new DynamoDBClient(config);
  const prepared=await db.send(new GetItemCommand({TableName:'YahooAuctionPreparation'+suffix,Key:marshall({inventoryId}),ConsistentRead:true}));
  const saved=parseYahooSaved(prepared.Item?unmarshall(prepared.Item):null);
  if(!saved||saved.payload.input.title!=='THONET トーネット アームチェア ダイニングチェア 1脚'||
     saved.payload.input.priceYen!==99999||saved.payload.input.quantity!==1)throw Error();
  const secret=await new SecretsManagerClient(config).send(new GetSecretValueCommand({SecretId:'bello/yahoo-web-session-staging',VersionStage:'AWSCURRENT'}));
  const session=YahooWebSession.fromStoredSession(secret.SecretString??'');if(!session.ok)throw Error();
  const live=await session.value.inspectListing(auctionId);
  if(!live.ok||live.value.title!==saved.payload.input.title||live.value.priceYen!==99999||live.value.quantity!==1||
     live.value.status!=='cancelled'||live.value.bids!==0)throw Error();
  const now=new Date().toISOString();
  const row={inventoryId,auctionId,title:live.value.title,priceYen:99999,quantity:1,remoteStatus:'cancelled',bids:0,
    checkedAt:live.value.checkedAt,revision:1,createdAt:now,updatedAt:now,__typename:'YahooAuctionListing'};
  const existing=await db.send(new GetItemCommand({TableName:'YahooAuctionListing'+suffix,Key:marshall({inventoryId}),ConsistentRead:true}));
  if(existing.Item){const r=parseYahooListingResult(unmarshall(existing.Item));
    if(r?.auctionId===auctionId&&r.remoteStatus==='cancelled'){console.log(JSON.stringify({ok:true,code:'ALREADY_LINKED'}));return;}throw Error();}
  await db.send(new PutItemCommand({TableName:'YahooAuctionListing'+suffix,Item:marshall(row),ConditionExpression:'attribute_not_exists(inventoryId)'}));
  const read=await db.send(new GetItemCommand({TableName:'YahooAuctionListing'+suffix,Key:marshall({inventoryId}),ConsistentRead:true}));
  const verified=parseYahooListingResult(read.Item?unmarshall(read.Item):null);
  if(verified?.auctionId!==auctionId||verified.remoteStatus!=='cancelled')throw Error();
  console.log(JSON.stringify({ok:true,auctionId,inventoryId,status:'cancelled',bids:0}));
}
main().catch(()=>{console.log(JSON.stringify({ok:false,code:'RESULT_IMPORT_NOT_CONFIRMED'}));process.exitCode=1});
