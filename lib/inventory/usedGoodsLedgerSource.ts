import 'server-only';
import {ScanCommand,type ScanCommandInput,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table} from './categoryPersistence';
import {buildUsedGoodsLedger,LEDGER_SOURCE_FIELDS,type LedgerSource} from './usedGoodsLedger';
import {inventoryCategoryIds,type CategoryRecord} from './categories';

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
  const categories=new Map<string,string>();
  cursor=undefined;
  do {
    const result:ScanCommandOutput=await db.send(new ScanCommand({TableName:table('Category'),ProjectionExpression:'#id,#name',ExpressionAttributeNames:{'#id':'id','#name':'name'},ExclusiveStartKey:cursor,ConsistentRead:true}));
    for(const category of result.Items??[])if(typeof category.id==='string'&&typeof category.name==='string')categories.set(category.id,category.name);
    cursor=result.LastEvaluatedKey;
  }while(cursor);
  return buildUsedGoodsLedger(sources.map(source=>({...source,categoryNames:inventoryCategoryIds(source as CategoryRecord).map(id=>categories.get(id)).filter(Boolean)})),year);
}
