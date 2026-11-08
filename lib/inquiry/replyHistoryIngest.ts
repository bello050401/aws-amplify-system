import {redactInquiryRecord} from '@/lib/messaging/contactPrivacy';
import 'server-only';
import { buildHistoricalReplies } from './replyHistory';
import { saveHistoricalReplies } from './replyHistoryStore';
import type { MessageRecord } from '@/lib/messaging/types';
import type { ReadSnapshot } from './runtime/readContract';

/** Call only with server-validated read snapshots / persisted SENT staff replies. */
export async function rememberVerifiedReplies(input:{conversationId:string;channel:string;messages:MessageRecord[];remote?:ReadSnapshot}):Promise<void>{
 input=redactInquiryRecord(input);
  const remote=input.remote;
  const automatic=new Set(input.messages.filter(m=>m.senderType==='AI'||m.aiGenerated).map(m=>m.body));
  const messages=remote ? remote.messages.map((m,i)=>({id:m.sentAt+'#'+i,body:m.body,sentAt:m.sentAt,
    direction:m.speaker==='BUYER'?'INBOUND' as const:'OUTBOUND' as const,verifiedStaff:m.speaker==='SELLER'&&!automatic.has(m.body)})) :
    input.messages.map(m=>({id:m.id,body:m.body,sentAt:m.externalSentAt??m.createdAt,direction:m.direction,
      verifiedStaff:m.direction==='OUTBOUND'&&m.senderType==='STAFF'&&m.deliveryStatus==='SENT'&&!m.aiGenerated}));
  try{await saveHistoricalReplies(buildHistoricalReplies({conversationId:input.conversationId,sourceId:remote?.inquiryId??input.conversationId,
    channel:input.channel,sourceUrl:remote?.url,messages}));}
  catch{console.warn('[inquiry] REPLY_HISTORY_INDEX_FAILED');}
}
