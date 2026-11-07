import 'server-only';
import {getLineAccessToken} from '@/lib/messaging/line/tokenAccess';
import {configuredMercariInquiryClient,MercariInquiryError} from '@/lib/messaging/mercari/inquiryAdapter';
import {CUSTOMER_DELIVERY_ENABLED} from '@/lib/messaging/featureState';
import {transportOutcome,type DeliveryState} from './deliveryPolicy';
export type CustomerTarget={channel:'LINE'|'MERCARI_SHOPS';account:string;recipient:string};
export async function sendCustomerMessage(target:CustomerTarget,body:string,retryKey:string,fresh:()=>Promise<boolean>,expectedRemote?:import('./readContract').ReadSnapshot):Promise<{status:DeliveryState;receipt?:string}>{
  if(!CUSTOMER_DELIVERY_ENABLED)throw Error('DELIVERY_DISABLED');
  if(!body.trim()||!retryKey)throw Error('INVALID_SEND');
  if(target.channel==='MERCARI_SHOPS'){
    if(!expectedRemote||expectedRemote.shopId!==target.account||expectedRemote.inquiryId!==target.recipient)return {status:'CANCELLED'};
    try{const client=await configuredMercariInquiryClient(target.account);
      const latest=await client.read(target.recipient);
      if(latest.messages.at(-1)?.from!=='BUYER')return {status:'CANCELLED'};
      const stamp=(rows:{speaker:string;body:string;sentAt:string}[])=>JSON.stringify(rows.map(m=>[m.speaker,m.body,Math.floor(Date.parse(m.sentAt)/60000)]));
      if(stamp(latest.messages.filter(m=>m.status==='ACTIVE'&&['BUYER','SELLER'].includes(m.from)).map(m=>({speaker:m.from,body:m.body,sentAt:m.sentAt})))!==stamp(expectedRemote.messages))return {status:'CANCELLED'};
      const sent=await client.send(target.recipient,body,retryKey,fresh);return {status:'ACCEPTED',receipt:sent.id};
    }catch(e){return {status:e instanceof MercariInquiryError&&!e.uncertain?'REJECTED':'UNKNOWN'};}
  }
  if(process.env.LINE_OUTBOUND_ENABLED!=='true')throw Error('LINE_DELIVERY_DISABLED');
  if(!/^U[a-f0-9]{32}$/.test(target.recipient)||!/^U[a-f0-9]{32}$/.test(target.account)||body.length>5000)throw Error('INVALID_LINE_TARGET');
  const token=await getLineAccessToken();if(!token)throw Error('LINE_NOT_CONFIGURED');
  const headers={Authorization:'Bearer '+token};
  // The account must be the same official account which received the webhook.
  const account=await fetch('https://api.line.me/v2/bot/info',{headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!account.ok||(await account.json()).userId!==target.account)throw Error('LINE_ACCOUNT_MISMATCH');
  if(!await fresh())return {status:'CANCELLED'};
  let response:Response;
  try{response=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),headers:{...headers,'Content-Type':'application/json','X-Line-Retry-Key':retryKey},body:JSON.stringify({to:target.recipient,messages:[{type:'text',text:body}]})});}
  catch{return {status:'UNKNOWN'};}
  const receipt=response.headers.get(response.status===409?'x-line-accepted-request-id':'x-line-request-id');
  await response.body?.cancel().catch(()=>{});
  return {status:transportOutcome(response.status,!!receipt),...(receipt?{receipt}: {})};
}
