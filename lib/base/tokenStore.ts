import {GetCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {randomUUID} from 'node:crypto';
/** Shared by the authenticated web server and the order worker. Never returns a token to a browser. */
export async function baseAccessToken(db:DynamoDBDocumentClient,table:string,credentials:()=>Promise<{clientId:string;clientSecret:string}|null>,transport:typeof fetch=fetch){
 const Key={id:'singleton'},read=async()=>(await db.send(new GetCommand({TableName:table,Key,ConsistentRead:true}))).Item;
 const token=await read();if(!token?.accessToken||!token.refreshToken)throw Error('BASE_ORDERS_AUTH_REQUIRED');
 if(Date.parse(token.expiresAt)>Date.now()+60000)return String(token.accessToken);
 if(token.refreshBlocked)throw Error('BASE_ORDERS_AUTH_REQUIRED');
 const owner=randomUUID(),now=Date.now();
 try{await db.send(new UpdateCommand({TableName:table,Key,UpdateExpression:'SET refreshOwner=:o,refreshLeaseUntil=:e',ConditionExpression:'refreshToken=:r AND (attribute_not_exists(refreshLeaseUntil) OR refreshLeaseUntil<:n) AND attribute_not_exists(refreshBlocked)',ExpressionAttributeValues:{':o':owner,':e':now+60000,':n':now,':r':token.refreshToken}}));}
 catch{const latest=await read();if(latest&&Date.parse(latest.expiresAt)>Date.now()+60000)return String(latest.accessToken);throw Error('BASE_TOKEN_BUSY');}
 try{
  const creds=await credentials();if(!creds)throw Error('BASE_ORDERS_AUTH_REQUIRED');
  // No retries: a successful refresh may rotate the refresh token even if its response is lost.
  const response=await transport('https://api.thebase.in/1/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refreshToken,client_id:creds.clientId,client_secret:creds.clientSecret}),redirect:'error',signal:AbortSignal.timeout(12000)});
  const body=await response.json();if(!response.ok||typeof body.access_token!=='string'||!Number.isFinite(Number(body.expires_in))||Number(body.expires_in)<=0)throw Error('BASE_ORDERS_AUTH_REQUIRED');
  const at=new Date().toISOString();
  await db.send(new UpdateCommand({TableName:table,Key,UpdateExpression:'SET accessToken=:a,refreshToken=:r,expiresAt=:e,updatedAt=:at REMOVE refreshOwner,refreshLeaseUntil',ConditionExpression:'refreshOwner=:o AND refreshToken=:old',ExpressionAttributeValues:{':a':body.access_token,':r':body.refresh_token||token.refreshToken,':e':new Date(Date.now()+Number(body.expires_in)*1000).toISOString(),':at':at,':o':owner,':old':token.refreshToken}}));
  return body.access_token as string;
 }catch{
  const latest=await read();if(latest&&Date.parse(latest.expiresAt)>Date.now()+60000)return String(latest.accessToken);
  await db.send(new UpdateCommand({TableName:table,Key,UpdateExpression:'SET refreshBlocked=:yes REMOVE refreshOwner,refreshLeaseUntil',ConditionExpression:'refreshOwner=:o AND refreshToken=:old',ExpressionAttributeValues:{':yes':true,':o':owner,':old':token.refreshToken}})).catch(()=>{});
  throw Error('BASE_ORDERS_AUTH_REQUIRED');
 }
}
