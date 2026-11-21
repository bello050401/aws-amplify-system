import {GetSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {PutCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {YahooWebSession} from '../listing/yahooAuction/webHttpSession';
import type {SaleCandidate} from './model';
import {corroborateYahooSale,corroborateLinkedYahooSale,type YahooSaleOwnership} from './yahooSaleFacts';
import type {YahooListingEvidence} from '../listing/yahooAuction/webHttpListing';
import {readYahooPublicSaleEvidence,type YahooPublicSaleEvidence} from './yahooPublicSaleEvidence';

type LinkedOwnership=YahooSaleOwnership&{inventoryTable:string;quantity:number};
type FallbackPorts={readPublic:(id:string)=>Promise<YahooPublicSaleEvidence>;liveOwnership:(c:SaleCandidate)=>Promise<LinkedOwnership|null>};
async function liveLinkedOwnership(c:SaleCandidate):Promise<LinkedOwnership|null>{
 const [{exactListingInventoryIds},{ensureAutomaticSaleBinding},{getInventoryRaw,inventoryTable}]=await Promise.all([import('./listingMatch'),import('./saleBinding'),import('../inventory/categoryPersistence')]);
 const ids=await exactListingInventoryIds('YAHOO',c.orderId);if(ids.length!==1)return null;
 const before=await getInventoryRaw(ids[0]);
 if(!before||before.isDeleted||before.deletedAt||!Number.isSafeInteger(before.quantity)||before.quantity<1)return null;
 if(!await ensureAutomaticSaleBinding(ids[0],'YAHOO',c.orderId,'BELLO_SALE_AUTOMATION'))return null;
 const current=await getInventoryRaw(ids[0]);if(!current||current.updatedAt!==before.updatedAt||current.quantity!==before.quantity||current.isDeleted||current.deletedAt)return null;
 return {inventoryId:ids[0],inventoryVersion:current.updatedAt,bindingCheckedAt:new Date().toISOString(),inventoryTable:inventoryTable('Inventory'),quantity:current.quantity};
}

async function readOwnedSale(auctionId:string):Promise<YahooListingEvidence>{
 // This private runtime has read access to exactly this pre-existing session.
 const secret=await new SecretsManagerClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}).send(new GetSecretValueCommand({SecretId:'bello/yahoo-web-session-staging'}));
 const session=YahooWebSession.fromStoredSession(secret.SecretString||'');
 if(!session.ok)throw Error('YAHOO_SALE_AUTH_REQUIRED');
 const evidence=await session.value.inspectListing(auctionId);
 if(!evidence.ok){const codes:Record<string,string>={AUTH_REQUIRED:'YAHOO_SALE_AUTH_REQUIRED',ACCESS_DENIED:'YAHOO_SALE_ACCESS_DENIED',RATE_LIMITED:'YAHOO_SALE_RATE_LIMITED',UNEXPECTED_FORM:'YAHOO_SALE_FORM_CHANGED'};throw Error(codes[evidence.code]??'YAHOO_SALE_READ_UNAVAILABLE');}
 return evidence.value;
}

/** Server-only provenance ports; no caller-supplied HTTP proof or ownership assertions. */
export function createYahooSaleFactCompleter(readProof:(id:string)=>Promise<YahooListingEvidence>,fallback?:FallbackPorts){
 return async function(c:SaleCandidate,db:DynamoDBDocumentClient,table:string):Promise<SaleCandidate>{
 if(c.channel!=='YAHOO'||c.source!=='GMAIL'||c.state!=='PENDING'||!c.senderAuthenticated||!c.yahooAuthenticatedWonAt||!Number.isFinite(Date.parse(c.yahooAuthenticatedWonAt))||!c.yahooEvents?.WON||c.unitPrice===null||c.quantity!==null)return c;
 let next:SaleCandidate|null,ownership:LinkedOwnership|null=null;
 try{next=corroborateYahooSale(c,await readProof(c.orderId));}
 catch(error){
  // A denied/challenged/rate-limited request is never retried through another transport.
  if(!fallback||!['YAHOO_SALE_FORM_CHANGED','YAHOO_SALE_AUTH_REQUIRED'].includes((error as Error).message))throw error;
  if(c.identifierType!=='AUCTION'||c.externalListingId!==c.orderId||c.orderLineCount!==1||!Number.isFinite(Date.parse(c.yahooEvents.WON))||c.warnings.some(w=>/異なる|取引ナビで/.test(w)))return c;
  ownership=await fallback.liveOwnership(c);if(!ownership)return c;
  const link:YahooSaleOwnership={inventoryId:ownership.inventoryId,inventoryVersion:ownership.inventoryVersion,bindingCheckedAt:ownership.bindingCheckedAt};
  next=corroborateLinkedYahooSale(c,await fallback.readPublic(c.orderId),link);
 }
 if(!next||next===c)return c;
 next.updatedAt=new Date(Math.max(Date.now(),Date.parse(c.updatedAt)+1)).toISOString();
 const put={TableName:table,Item:next,ConditionExpression:'#s=:pending AND updatedAt=:v',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':pending':'PENDING',':v':c.updatedAt}};
 if(ownership)await db.send(new TransactWriteCommand({TransactItems:[{ConditionCheck:{TableName:ownership.inventoryTable,Key:{id:ownership.inventoryId},ConditionExpression:'updatedAt=:v AND quantity=:q AND (attribute_not_exists(isDeleted) OR isDeleted=:no)',ExpressionAttributeValues:{':v':ownership.inventoryVersion,':q':ownership.quantity,':no':false}}},{Put:put}]}));
 else await db.send(new PutCommand(put));
 return next;
 };
}
export const completeYahooSaleFacts=createYahooSaleFactCompleter(readOwnedSale,{readPublic:readYahooPublicSaleEvidence,liveOwnership:liveLinkedOwnership});
