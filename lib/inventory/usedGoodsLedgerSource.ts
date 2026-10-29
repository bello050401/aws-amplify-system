import 'server-only';
import {ScanCommand,type ScanCommandInput} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table} from './categoryPersistence';
import {buildUsedGoodsLedger,LEDGER_SOURCE_FIELDS,type LedgerSource} from './usedGoodsLedger';

/** Called only after the API's ADMIN check. Paginate, project only ledger fields, never cache PII. */
export async function loadUsedGoodsLedger(year:number) {
  const sources:LedgerSource[]=[];
  let cursor:ScanCommandInput['ExclusiveStartKey'];
  do {
    const result=await db.send(new ScanCommand({TableName:table('Inventory'),
      ProjectionExpression:LEDGER_SOURCE_FIELDS.map((_,i)=>`#f${i}`).join(','),
      ExpressionAttributeNames:Object.fromEntries(LEDGER_SOURCE_FIELDS.map((f,i)=>[`#f${i}`,f])),
      ExclusiveStartKey:cursor,ConsistentRead:true}));
    sources.push(...result.Items??[]);cursor=result.LastEvaluatedKey;
  }while(cursor);
  return buildUsedGoodsLedger(sources,year);
}
