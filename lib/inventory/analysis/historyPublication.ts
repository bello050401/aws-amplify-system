import {TransactWriteCommand, type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {ANALYSIS_RETAIN_DAILY, dailyKey, generationKey, makeAnalysisManifest, parseAnalysisManifest} from './publicationFormat';
import type {AnalysisBuild} from './types';

/** A reviewable, bounded atomic create. Never updates current, captured daily
 * observations, existing generations or original source archives. */
export function historicalPublicationItems(build:AnalysisBuild, actor:string){
  if(build.metadata.accuracy!=='reference-reconstructed'||!build.metadata.inventoryHistory||
    build.sales.length||build.acquisitions.length||build.retailReference.length)throw Error('HISTORY_PUBLICATION_BASIS');
  const {dailyManifest,shards}=makeAnalysisManifest(build),{generation,coverageEnd,sourceRecordCount}=build.metadata;
  const json=JSON.stringify(dailyManifest);parseAnalysisManifest(json,generation);
  const until=Math.floor(Date.parse(coverageEnd)/1000)+ANALYSIS_RETAIN_DAILY+86400;
  const base={__typename:'SalesAggregateSnapshot',generation,monthsJson:'[]',sourceRecordCount,
    rebuiltBy:actor,rebuiltAt:build.metadata.inventoryHistory.reconstructedAt,createdAt:build.metadata.inventoryHistory.reconstructedAt,
    updatedAt:build.metadata.inventoryHistory.reconstructedAt};
  const items=[
    {...base,id:dailyKey(coverageEnd),analysisManifestJson:json,analysisRetentionGroup:'daily',analysisRetainUntil:until},
    {...base,id:generationKey(generation),analysisManifestJson:json,analysisShardIds:shards.map(s=>s.id),analysisRetentionGroup:'generation',analysisRetainUntil:until},
    ...shards.map(s=>({...base,id:s.id,analysisShardJson:s.json})),
  ];
  if(items.length>100||items.some(item=>Buffer.byteLength(JSON.stringify(item))>390*1024)||
    items.reduce((n,item)=>n+Buffer.byteLength(JSON.stringify(item)),0)>3_900_000)throw Error('HISTORY_PUBLICATION_SIZE');
  return items;
}

export async function publishHistoricalInventory(db:Pick<DynamoDBDocumentClient,'send'>,table:string,build:AnalysisBuild,actor:string){
  const items=historicalPublicationItems(build,actor);
  try{await db.send(new TransactWriteCommand({TransactItems:items.map(Item=>({Put:{TableName:table,Item,ConditionExpression:'attribute_not_exists(id)'}}))}));return true;}
  catch(error){
    const e=error as {name?:string;CancellationReasons?:{Code?:string}[]};
    if(e.name==='TransactionCanceledException'&&e.CancellationReasons?.some(reason=>reason.Code==='ConditionalCheckFailed'))return false;
    throw error;
  }
}
