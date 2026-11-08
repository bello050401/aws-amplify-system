import 'server-only';
import {GetCommand, QueryCommand} from '@aws-sdk/lib-dynamodb';
import {directTableName} from '@/lib/amplify/directData';
import {inventoryVerifiedReadSession} from '@/lib/inventory/mutationSession';
import {toConversationRecord, toMessageRecord} from '@/lib/messaging/service';
import {toReplyDraftRecord} from '@/lib/inquiry/draftStore';
import {inquiryDb} from './store';

// This read-only server boundary verifies signature, expiry, client and role
// before using the hosting IAM role. It does not fall back after auth failure.
async function authorize() {
  const session=await inventoryVerifiedReadSession();
  if(!session || !['ADMIN','EDITOR'].includes(session.role))throw Error('操作権限がありません。');
}
function validId(id:string){if(typeof id!=='string'||!id.length||id.length>200)throw Error('対象を確認できません。');}

async function rowsFor(model:'Message'|'ReplyDraft', conversationId:string) {
  const rows:Record<string,unknown>[]=[];
  let key:Record<string,unknown>|undefined;
  for(let page=0;page<100;page++) {
    const result=await inquiryDb.send(new QueryCommand({
      TableName:directTableName(model),
      IndexName:model==='Message'?'messagesByConversationId':'replyDraftsByConversationId',
      KeyConditionExpression:'conversationId=:conversation',
      ExpressionAttributeValues:{':conversation':conversationId},
      ExclusiveStartKey:key,Limit:200,
    }));
    for(const row of result.Items??[]) {
      if(row.conversationId!==conversationId)throw Error('会話の対応を確認できません。');
      rows.push(row);
    }
    key=result.LastEvaluatedKey;
    if(!key)return rows;
  }
  throw Error('会話の取得を完了できませんでした。');
}

export async function readInquiryConversationView(conversationId:string) {
  await authorize();validId(conversationId);
  const {Item:conversation}=await inquiryDb.send(new GetCommand({TableName:directTableName('Conversation'),Key:{id:conversationId},ConsistentRead:true}));
  if(!conversation||conversation.deletedAt)return null;
  if(conversation.id!==conversationId)throw Error('会話の対応を確認できません。');
  const [messages,drafts]=await Promise.all([rowsFor('Message',conversationId),rowsFor('ReplyDraft',conversationId)]);
  return {
    conversation:toConversationRecord(conversation as Parameters<typeof toConversationRecord>[0]),
    messages:messages.map(row=>toMessageRecord(row as Parameters<typeof toMessageRecord>[0])).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),
    drafts:drafts.map(row=>toReplyDraftRecord(row as unknown as Parameters<typeof toReplyDraftRecord>[0])).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
  };
}

export async function readInquiryMessage(conversationId:string,messageId:string) {
  await authorize();validId(conversationId);validId(messageId);
  const {Item:row}=await inquiryDb.send(new GetCommand({TableName:directTableName('Message'),Key:{id:messageId},ConsistentRead:true}));
  if(!row||row.conversationId!==conversationId)return null;
  return toMessageRecord(row as Parameters<typeof toMessageRecord>[0]);
}
