import {GetSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {YahooWebSession} from '../../../lib/listing/yahooAuction/webHttpSession';
const region='us-west-2';
/** Private worker metadata only; frontend outputs and caller-selected secrets are never inputs. */
export function yahooRuntimeConfig(){
 const stateTable=process.env.YAHOO_WEB_STATE_TABLE;
 return (process.env.AWS_REGION??region)===region&&typeof stateTable==='string'&&/^[A-Za-z0-9_.-]{3,255}$/.test(stateTable)?{region,stateTable}:null;
}
export async function readYahooRuntimeSession(){
 const config=yahooRuntimeConfig();if(!config)return {ok:false as const,code:'NOT_CONFIGURED' as const};
 try{
  const stored=await new SecretsManagerClient({region,maxAttempts:1}).send(new GetSecretValueCommand({SecretId:'bello/yahoo-web-session-staging',VersionStage:'AWSCURRENT'}));
  const opened=YahooWebSession.fromStoredSession(stored.SecretString??'');
  return opened.ok?{ok:true as const,session:opened.value}:{ok:false as const,code:'AUTH_REQUIRED' as const};
 }catch{return {ok:false as const,code:'SESSION_UNAVAILABLE' as const};}
}
