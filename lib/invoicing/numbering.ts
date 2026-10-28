import {GetCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {dateValid} from './model';
export function invoiceNumber(date:string,sequence:number){
 if(!dateValid(date)||!Number.isSafeInteger(sequence)||sequence<1||sequence>99999)throw new Error('INVALID_NUMBER');
 return date.replaceAll('-','')+String(sequence);
}
// Only a date and last reserved ordinal are retained. No recipient, amounts,
// provider document ID or PDF. No TTL: expiry could reissue an old number.
// A lost response/failure consumes the ordinal; never recycle uncertain numbers.
export async function reserveInvoiceNumber(db:Pick<DynamoDBDocumentClient,'send'>,table:string,date:string,start=1){
 invoiceNumber(date,start);const id='invoice-number#'+date;
 for(let attempt=0;attempt<8;attempt++){
  const r=await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}));
  const previous=r.Item?.last;
  if(previous!==undefined&&(!Number.isSafeInteger(previous)||previous<0))throw new Error('INVALID_COUNTER');
  const next=Math.max((previous??0)+1,start);const number=invoiceNumber(date,next);
  try{await db.send(new UpdateCommand({TableName:table,Key:{id},UpdateExpression:'SET #last=:next',
   ConditionExpression:previous===undefined?'attribute_not_exists(#last)':'#last=:previous',
   ExpressionAttributeNames:{'#last':'last'},ExpressionAttributeValues:{':next':next,...(previous===undefined?{}:{':previous':previous})}}));return number;
  }catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
 }
 throw new Error('NUMBER_BUSY');
}
