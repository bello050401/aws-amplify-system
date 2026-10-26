import 'server-only';
import {cookies} from 'next/headers';
import {fetchAuthSession} from 'aws-amplify/auth/server';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import {runWithAmplifyServerContext} from '../amplify/serverUtils';
import outputs from '../../amplify_outputs.json';
import {deviceSecurityEnabled} from '../security/serverRuntime';
import {approvedServerSession} from '../security/serverSession';
export const NO_STORE={'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Cookie','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const verifier=CognitoJwtVerifier.create({userPoolId:outputs.auth.user_pool_id,clientId:outputs.auth.user_pool_client_id,tokenUse:'access'});
export async function adminCredential(){
 if(deviceSecurityEnabled()){
  // The approved server grant is bound to this request and rechecks revocation.
  // Its JWT belongs to the confidential client, not the legacy browser client.
  const session=await approvedServerSession();
  return session?.groups.includes('ADMIN')?session.tokens.access:null;
 }
 return runWithAmplifyServerContext({nextServerContext:{cookies},operation:async context=>{const s=await fetchAuthSession(context);const t=s.tokens?.accessToken;if(!t)return null;try{const verified=await verifier.verify(t.toString());return verified['cognito:groups']?.includes('ADMIN')?t.toString():null;}catch{return null;}}});
}
export async function invokeIssuer(token:string,action:string,params:Record<string,unknown>={}){
 const config=(outputs as unknown as {custom?:{invoicing?:{region:string;functionName:string}}}).custom?.invoicing;
 if(!config)return {ok:false,code:'NOT_CONFIGURED',message:'請求書発行の接続を準備しています。'};
 const result=await new LambdaClient({region:config.region,maxAttempts:1}).send(new InvokeCommand({FunctionName:config.functionName,InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify({token,action,...params}))}));
 if(result.FunctionError||!result.Payload)throw new Error('ISSUER_UNAVAILABLE');
 return JSON.parse(Buffer.from(result.Payload).toString('utf8'));
}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');return request.headers.get('x-bello-invoicing')==='1'&&request.headers.get('sec-fetch-site')!=='cross-site'&&(!origin||origin===(process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin));}
export async function bodyLimited(request:Request){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new Error('INVALID_BODY');
 const reader=request.body?.getReader();if(!reader)throw new Error('INVALID_BODY');const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const n=await reader.read();if(n.done)break;length+=n.value.length;if(length>65536){await reader.cancel();throw new Error('BODY_TOO_LARGE');}chunks.push(n.value);}}finally{reader.releaseLock();}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
