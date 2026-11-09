import {DynamoDBDocumentClient,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {prepareInventoryHistoryWrites} from '../inventory/historyTransaction';
/** Retry only a DynamoDB transaction collision; conditional failures remain final. */
export async function sendOutboundTransaction(db:Pick<DynamoDBDocumentClient,'send'>,command:TransactWriteCommand) {
 if(command.input.TransactItems?.some(item=>item.Update&&/^Inventory(?:-|$)/.test(item.Update.TableName??''))){
  const prepared=await prepareInventoryHistoryWrites(db,command.input.TransactItems,{source:'出庫・到着確認'});
  command=new TransactWriteCommand({...command.input,TransactItems:prepared.writes});
 }
 for(let attempt=0;;attempt++)try{return await db.send(command);}catch(error){
  const reasons=(error as {CancellationReasons?:{Code?:string}[]}).CancellationReasons;
  const collision=(error as Error).name==='TransactionConflictException'||((error as Error).name==='TransactionCanceledException'&&reasons?.some(r=>r.Code==='TransactionConflict')&&reasons.every(r=>!r.Code||['None','TransactionConflict'].includes(r.Code)));
  if(!collision||attempt>=4)throw error;
  await new Promise(resolve=>setTimeout(resolve,80*2**attempt+Math.random()*80));
 }
}
