import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import type {PurchaseMail} from './mailParser';
type Part={mimeType?:string;body?:{data?:string};headers?:{name:string;value:string}[];parts?:Part[]};
export async function purchaseGmailReader(){
 const s=await new SecretsManagerClient({region:process.env.AWS_REGION||'us-west-2'}).send(new GetSecretValueCommand({SecretId:'bello/gmail-oauth'}));
 const c=JSON.parse(s.SecretString||'{}');if(!c.configured||!c.refreshToken)throw Error('GMAIL_NOT_CONFIGURED');
 const t=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:c.refreshToken,grant_type:'refresh_token'})});
 if(!t.ok)throw Error('GMAIL_AUTH_REQUIRED');const token=await t.json();if(!token.access_token)throw Error('GMAIL_AUTH_REQUIRED');
 const get=async(path:string)=>{const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me'+path,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token.access_token}});if(!r.ok)throw Error(r.status===401||r.status===403?'GMAIL_AUTH_REQUIRED':r.status===429?'GMAIL_RATE_LIMIT':'GMAIL_UNAVAILABLE');return r.json();};
 return {
  list:async(query:string,page?:string)=>get('/messages?'+new URLSearchParams({q:query,maxResults:'50',...(page?{pageToken:page}:{})})),
  read:async(id:string):Promise<PurchaseMail>=>{
   if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('INVALID_ID');
   const m=await get('/messages/'+id+'?format=full');const text:string[]=[],html:string[]=[];
   const visit=(p:Part)=>{if(p.body?.data&&p.mimeType==='text/plain')text.push(Buffer.from(p.body.data,'base64url').toString('utf8'));if(p.body?.data&&p.mimeType==='text/html')html.push(Buffer.from(p.body.data,'base64url').toString('utf8'));p.parts?.forEach(visit);};if(m.payload)visit(m.payload);
   const h=(key:string)=>(m.payload?.headers as Part['headers'])?.find(v=>v.name.toLowerCase()===key)?.value||'';
   return {gmailId:id,from:h('from'),subject:h('subject'),receivedAt:new Date(Number(m.internalDate)).toISOString(),text:text.join('\n'),html:html.join('\n')};
  }
 };
}
