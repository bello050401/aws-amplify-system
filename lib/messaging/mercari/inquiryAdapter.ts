import "server-only";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CUSTOMER_DELIVERY_ENABLED } from "../featureState";

// Official schema verified 2026-11-08: https://api.mercari-shops.com/docs/index.html
// This boundary exposes fixed operations only. It never retries an uncertain send.
export interface MercariInquiryMessage {
  id:string; inquiryId:string; body:string; from:"BUYER"|"SELLER"|"UNSPECIFIED";
  sentAt:string; status:"ACTIVE"|"ADMIN_DELETED"|"BLOCKED"|"UNSPECIFIED"; attachments:{url:string}[];
}
export interface MercariInquiry {id:string;lastActivityAt:string;status:string;target:{__typename:string;productId?:string;productVariantId?:string|null;orderTransaction?:{id:string}|null;shopId?:string}}
type Page<T>={edges:{node:T}[];pageInfo:{hasNextPage:boolean;endCursor:string|null}};
type Credentials={accessToken:string;clientName:string;shopId:string};
export class MercariInquiryError extends Error {
  constructor(public code:string,public uncertain=false){super(code);this.name="MercariInquiryError";}
}
const ids=/^[A-Za-z0-9_-]{1,160}$/;
const target="__typename ... on InquiryProductTarget { productId productVariantId } ... on InquiryOrderTransactionTarget { orderTransaction { id } } ... on InquiryShopTarget { shopId }";
const fields="id inquiryId body from sentAt status attachments { url }";
const queries={
 account:"query BelloInquiryAccount { shop { id } }",
 detail:"query BelloInquiry($id:ID!) { inquiry(id:$id) { id lastActivityAt status target { "+target+" } } }",
 list:"query BelloInquiries($after:String) { inquiries(first:50,after:$after) { edges { node { id lastActivityAt status target { "+target+" } } } pageInfo { endCursor hasNextPage } } }",
 messages:"query BelloInquiryMessages($id:ID!,$after:String) { inquiryMessages(inquiryId:$id,first:200,after:$after) { edges { node { "+fields+" } } pageInfo { endCursor hasNextPage } } }",
 send:"mutation BelloInquirySend($input:AddInquiryMessageInput!) { addInquiryMessage(input:$input) { inquiryMessage { "+fields+" } } }",
} as const;
function checkId(id:string){if(!ids.test(id))throw new MercariInquiryError("INVALID_ID");}
function page<T>(value:Page<T>):Page<T>{
 if(!value||!Array.isArray(value.edges)||typeof value.pageInfo?.hasNextPage!=="boolean"||(value.pageInfo.hasNextPage&&!value.pageInfo.endCursor))throw new MercariInquiryError("INVALID_PAGE");
 return value;
}
function message(value:MercariInquiryMessage,id:string):MercariInquiryMessage{
 if(!value||!ids.test(value.id)||value.inquiryId!==id||!["BUYER","SELLER","UNSPECIFIED"].includes(value.from)||!["ACTIVE","ADMIN_DELETED","BLOCKED","UNSPECIFIED"].includes(value.status)||!Number.isFinite(Date.parse(value.sentAt))||typeof value.body!=="string"||!Array.isArray(value.attachments))throw new MercariInquiryError("INVALID_MESSAGE");
 return {...value,body:value.status==="ACTIVE"?value.body:"",attachments:value.status==="ACTIVE"?value.attachments.filter(a=>{try{return new URL(a.url).protocol==="https:";}catch{return false;}}):[]};
}
export function createMercariInquiryClient(credentials:Credentials,transport:typeof fetch=fetch){
 checkId(credentials.shopId);
 if(!credentials.accessToken||!credentials.clientName||/[\r\n]/.test(credentials.clientName))throw new MercariInquiryError("CONFIG_REQUIRED");
 async function call<T>(operation:keyof typeof queries,variables:Record<string,unknown>={}):Promise<T>{
  const writing=operation==="send";let response:Response;
  try{response=await transport("https://api.mercari-shops.com/v1/graphql",{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000),headers:{"Content-Type":"application/json",Authorization:"Bearer "+credentials.accessToken,"User-Agent":credentials.clientName+"/2026-11-08"},body:JSON.stringify({query:queries[operation],variables})});}
  catch{throw new MercariInquiryError("NETWORK_ERROR",writing);}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new MercariInquiryError(response.status===429?"RATE_LIMITED":response.status===401||response.status===403?"AUTH_REQUIRED":"HTTP_"+response.status,writing&&response.status>=500);}
  let payload:{data:T;errors?:unknown[]};
  try{const reader=response.body?.getReader();if(!reader)throw Error();let bytes=0;const chunks:Uint8Array[]=[];for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1500000){await reader.cancel();throw Error();}chunks.push(part.value);}payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
  catch{throw new MercariInquiryError("INVALID_RESPONSE",writing);}
  if(payload.errors?.length||!payload.data)throw new MercariInquiryError("REMOTE_REJECTED",writing);
  return payload.data;
 }
 async function account(){const data=await call<{shop:{id:string}}>("account");if(data.shop?.id!==credentials.shopId)throw new MercariInquiryError("ACCOUNT_MISMATCH");}
 return {
  verifyAccount:account,
  async list(after?:string){await account();return page((await call<{inquiries:Page<MercariInquiry>}>("list",{after:after??null})).inquiries);},
  async read(id:string){
   checkId(id);await account();
   const detail=(await call<{inquiry:MercariInquiry}>("detail",{id})).inquiry;if(detail?.id!==id)throw new MercariInquiryError("INQUIRY_MISMATCH");
   const rows=new Map<string,MercariInquiryMessage>(),seen=new Set<string>();let after:string|null=null;
   for(let n=0;n<25;n++){
    const p:Page<MercariInquiryMessage>=page((await call<{inquiryMessages:Page<MercariInquiryMessage>}>("messages",{id,after})).inquiryMessages);
    for(const e of p.edges){const m=message(e.node,id);rows.set(m.id,m);}
    if(!p.pageInfo.hasNextPage)return {inquiry:detail,messages:[...rows.values()].sort((a,b)=>a.sentAt.localeCompare(b.sentAt))};
    const next=p.pageInfo.endCursor!;if(seen.has(next))throw new MercariInquiryError("CURSOR_LOOP");seen.add(next);after=next;
   }
   throw new MercariInquiryError("PAGE_LIMIT");
  },
  async send(id:string,body:string,idempotencyKey:string,verifyImmediately:()=>Promise<boolean>){
   if(!CUSTOMER_DELIVERY_ENABLED)throw new MercariInquiryError("DELIVERY_DISABLED");
   checkId(id);if(!body.trim()||body.length>1000||!/^[-0-9a-f]{36}$/i.test(idempotencyKey))throw new MercariInquiryError("INVALID_MESSAGE_INPUT");
   await account();if(!await verifyImmediately())throw new MercariInquiryError("STALE_DRAFT");
   const data=await call<{addInquiryMessage:{inquiryMessage:MercariInquiryMessage}}>("send",{input:{inquiryId:id,body,idempotencyKey}});
   const sent=message(data.addInquiryMessage?.inquiryMessage,id);
   if(sent.from!=="SELLER"||sent.status!=="ACTIVE"||sent.body!==body)throw new MercariInquiryError("SEND_UNCONFIRMED",true);
   return sent;
  },
 };
}
export async function configuredMercariInquiryClient(shopId:string){
 const client=new SecretsManagerClient({region:process.env.AWS_REGION||"us-west-2"});
 const secret=await client.send(new GetSecretValueCommand({SecretId:"bello/mercari-access-token"}));
 let saved:{accessToken?:string;token?:string;clientName?:string};
 try{saved=JSON.parse(secret.SecretString??"");}catch{throw new MercariInquiryError("CONFIG_REQUIRED");}
 return createMercariInquiryClient({shopId,accessToken:saved.accessToken??saved.token??"",clientName:saved.clientName??""});
}
