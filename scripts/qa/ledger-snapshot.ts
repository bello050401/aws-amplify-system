import {mkdirSync,writeFileSync} from 'node:fs';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable} from '../../lib/inventory/categoryPersistence';
import {LEDGER_SOURCE_FIELDS,ledgerObject} from '../../lib/inventory/usedGoodsLedger';
async function main(){
 const fields=[...new Set([...LEDGER_SOURCE_FIELDS,'shippingCost','categoryId','categoryIds'])];
 const rows:Record<string,unknown>[]=[],categories:Record<string,unknown>[]=[];
 for(const [model,target,cols] of [['Inventory',rows,fields],['Category',categories,['id','name']]] as const){
  let cursor:Record<string,unknown>|undefined;do{const p=await db.send(new ScanCommand({TableName:inventoryTable(model),ProjectionExpression:cols.map((_,i)=>'#f'+i).join(','),ExpressionAttributeNames:Object.fromEntries(cols.map((x,i)=>['#f'+i,x])),ExclusiveStartKey:cursor,ConsistentRead:true}));target.push(...p.Items??[]);cursor=p.LastEvaluatedKey;}while(cursor);
 }
 const dir='artifacts/ledger-20261112';mkdirSync(dir,{recursive:true});writeFileSync(dir+'/source.json',JSON.stringify({checkedAt:new Date().toISOString(),rows,categories}));
 const manual=rows.filter(r=>String(r.transactionDate).startsWith('2026')&&!ledgerObject(r.customFields).__restageImport&&!ledgerObject(r.customFields).__yahooPurchaseImport&&!ledgerObject(r.customFields).__belloStockSplit);
 console.log(JSON.stringify({total:rows.length,manual:manual.length,categories:categories.map(c=>c.name),withPrice:manual.filter(r=>r.purchasePrice!=null).length,withShipping:manual.filter(r=>r.shippingCost!=null).length,withDailyTotal:manual.filter(r=>r.dailyPurchaseTotal!=null).length},null,2));
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});
