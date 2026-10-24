import 'server-only';
import {cookies} from 'next/headers';
import {fetchAuthSession} from 'aws-amplify/auth/server';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import {runWithUserPoolServerContext} from '../amplify/userPoolServer';
import {requestCache} from '../amplify/requestCache';
import outputs from '../../amplify_outputs.json';
const verifier=CognitoJwtVerifier.create({userPoolId:outputs.auth.user_pool_id,clientId:outputs.auth.user_pool_client_id,tokenUse:'access'});
/** Verify signature, expiry and app client before using server IAM to write stock. */
export const inventoryMutationSession=requestCache(async()=>{
 try{return await runWithUserPoolServerContext({nextServerContext:{cookies},operation:async context=>{
  const token=(await fetchAuthSession(context)).tokens?.accessToken;if(!token)return null;
  const verified=await verifier.verify(token.toString()),groups=verified['cognito:groups']??[];
  const role=groups.includes('ADMIN')?'ADMIN':groups.includes('EDITOR')?'EDITOR':null;
  return role?{owner:verified.sub,role}:null;
 }});}catch{return null;}
});
