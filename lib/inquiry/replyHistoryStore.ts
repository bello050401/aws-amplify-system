import 'server-only';
import {redactInquiryRecord} from '../messaging/contactPrivacy';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {createHash} from 'node:crypto';
import { runtimeConfig } from '@/lib/inquiry/runtime/config';
import { historyTopics, selectHistoricalReplies, REPLY_HISTORY_VERSION, type HistoricalReply } from './replyHistory';

const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2',maxAttempts:2}),{marshallOptions:{removeUndefinedValues:true}});
const partition=(topic:string)=>`REPLY_HISTORY#V${REPLY_HISTORY_VERSION}#${topic}`;

/** Same reply has a deterministic key. Replay does not extend retention. */
export async function saveHistoricalReplies(rows:HistoricalReply[]):Promise<number>{
  rows=redactInquiryRecord(rows);
  if(!rows.length)return 0;
  const source=rows[0];
  if(rows.some(r=>r.sourceId!==source.sourceId||r.channel!==source.channel))throw Error('HISTORY_SOURCE_MIXED');
  const key={pk:'REPLY_HISTORY_SOURCE#'+createHash('sha256').update(source.channel+':'+source.sourceId).digest('hex'),sk:'STATE'};
  const digest=createHash('sha256').update(rows.map(r=>r.id).join('|')).digest('hex');
  const previous=(await db.send(new GetCommand({TableName:runtimeConfig().table,Key:key}))).Item;
  if(previous?.digest===digest && previous.ttl>Math.floor(Date.now()/1000))return 0;
  let saved=0;
  for(const row of rows.slice(-80))for(const topic of row.topics.slice(0,6)){
    try{
      await db.send(new PutCommand({TableName:runtimeConfig().table,Item:{...row,pk:partition(topic),sk:row.sentAt+'#'+row.id,
        ttl:Math.floor(Date.now()/1000)+180*86400},ConditionExpression:'attribute_not_exists(pk)'}));saved++;
    }catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
  }
  await db.send(new PutCommand({TableName:runtimeConfig().table,Item:{...key,digest,ttl:Math.floor(Date.now()/1000)+179*86400}}));
  return saved;
}

export async function retrieveHistoricalReplies(input:Parameters<typeof selectHistoricalReplies>[1]):Promise<{status:'AVAILABLE'|'EMPTY'|'UNAVAILABLE';examples:HistoricalReply[]}>{
  const topics=historyTopics(input.text).slice(0,6);
  if(!topics.length)return {status:'EMPTY',examples:[]};
  try{
    const results=await Promise.all(topics.map(topic=>db.send(new QueryCommand({TableName:runtimeConfig().table,
      KeyConditionExpression:'pk=:pk',ExpressionAttributeValues:{':pk':partition(topic)},ScanIndexForward:false,Limit:40}))));
    const now=Math.floor(Date.now()/1000);
    const rows=results.flatMap(r=>r.Items??[]).filter(r=>typeof r.ttl==='number'&&r.ttl>now) as HistoricalReply[];
    const examples=selectHistoricalReplies(rows,input);
    return {status:examples.length?'AVAILABLE':'EMPTY',examples};
  }catch{
    // No raw transcript or SDK error (which may contain inputs) in logs.
    console.warn('[inquiry] REPLY_HISTORY_UNAVAILABLE');
    return {status:'UNAVAILABLE',examples:[]};
  }
}
