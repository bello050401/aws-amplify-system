import {DynamoDBDocumentClient,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
/** Retry only a DynamoDB transaction collision; conditional failures remain final. */
export async function sendOutboundTransaction(db:Pick<DynamoDBDocumentClient,'send'>,command:TransactWriteCommand) {
 for(let attempt=0;;attempt++)try{return await db.send(command);}catch(error){
  const reasons=(error as {CancellationReasons?:{Code?:string}[]}).CancellationReasons;
  const collision=(error as Error).name==='TransactionConflictException'||((error as Error).name==='TransactionCanceledException'&&reasons?.some(r=>r.Code==='TransactionConflict')&&reasons.every(r=>!r.Code||['None','TransactionConflict'].includes(r.Code)));
  if(!collision||attempt>=4)throw error;
  await new Promise(resolve=>setTimeout(resolve,80*2**attempt+Math.random()*80));
 }
}
