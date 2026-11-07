import {QueryCommand,BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import type {ExtractionRepository,ExtractionJob} from './jobs';
export async function registeredExtractionPage(repo:ExtractionRepository,provider:'RESTAGE'|'YAHOO',date:string,cursor?:string){
 if(!['RESTAGE','YAHOO'].includes(provider)||provider==='RESTAGE'&&!/^\d{4}-\d{2}-\d{2}$/.test(date)||cursor&&cursor.length>180)throw Error('仕入先と開催日を確認してください');
 const pk=provider==='RESTAGE'?'DATE#'+date:'YAHOO_PURCHASE';
 const page=await repo.db.send(new QueryCommand({TableName:repo.config.table,KeyConditionExpression:'pk=:p',ExpressionAttributeValues:{':p':pk},Limit:20,ExclusiveStartKey:cursor?{pk,sk:cursor}:undefined,ConsistentRead:true}));
 const ids=[...new Set((page.Items||[]).filter(r=>r.status==='REGISTERED'&&typeof r.inventoryId==='string').map(r=>r.inventoryId as string))];
 const rows:Record<string,unknown>[]=[],jobs:ExtractionJob[]=[];
 if(ids.length){
  let requests:NonNullable<ConstructorParameters<typeof BatchGetCommand>[0]['RequestItems']>={
   [repo.config.inventoryTable]:{Keys:ids.map(id=>({id})),ConsistentRead:true},
   [repo.config.table]:{Keys:ids.map(id=>({pk:'EXTRACTION#'+id,sk:'CURRENT'})),ConsistentRead:true},
  };
  for(let attempt=0;attempt<3&&Object.keys(requests).length;attempt++){
   const r=await repo.db.send(new BatchGetCommand({RequestItems:requests}));rows.push(...r.Responses?.[repo.config.inventoryTable]||[]);jobs.push(...(r.Responses?.[repo.config.table]||[]) as ExtractionJob[]);requests=r.UnprocessedKeys||{};
   if(Object.keys(requests).length&&attempt===2)throw Error('商品をすべて取得できませんでした。再読込してください');
  }
 }
 return{rows:rows.filter(r=>!r.deletedAt).map(r=>({id:String(r.id),name:String(r.name||''),sku:String(r.sku||''),job:jobs.find(j=>j.identity.inventoryId===r.id)||null})),cursor:page.LastEvaluatedKey?.sk as string|undefined};
}
