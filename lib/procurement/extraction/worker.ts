import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {RestageHttp} from '../restageHttp';
import {yahooDescriptionHtml} from '../yahooPublic';
import {yahooDescription,sha} from './sources';
import {extractDimensions} from './dimensions';
import {readRestageSheet} from './focusedOcr';
import {ExtractionRepository,sourceIdentity,identityKey,type ExtractionJob} from './jobs';
import {EXTRACTION_VERSION,type ExtractionResult} from './types';
import {customObject} from './merge';

export async function createExtractionAfterImport(repo:ExtractionRepository,row:Record<string,unknown>){
 if(row.status!=='REGISTERED'||typeof row.inventoryId!=='string')return;
 if(typeof row.pk!=='string'||!(row.pk==='YAHOO_PURCHASE'||/^DATE#\d{4}-\d{2}-\d{2}$/.test(row.pk)))return;
 const inventory=await repo.inventory(row.inventoryId);if(!inventory||inventory.deletedAt)return;
 const identity=sourceIdentity(inventory);if(!identity)return;
 if(identity.provider==='RESTAGE'&&(row.pk!=='DATE#'+identity.date||row.goodsId!==identity.externalId))return;
 if(identity.provider==='YAHOO'&&row.sk!==identity.externalId)return;
 const lot=customObject(row.lot);if(lot.lotNumber)identity.lotNumber=String(lot.lotNumber);
 try{await repo.request(identity,'SYSTEM:PROCUREMENT_IMPORT');}catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
}
const errorText=(e:unknown)=>{
 const code=(e as Error)?.message||'';
 if(/OCR/.test(code))return '出品表を確実に読み取れませんでした。原資料を確認し、抽出のみ再試行できます。';
 if(/DESCRIPTION/.test(code))return '商品説明の本文を取得・確認できませんでした。寸法記載なしとは扱っていません。';
 if(/リステージ/.test(code))return 'リステージへの接続・資料取得に失敗しました。接続を確認して再試行してください。';
 return '資料の取得・処理に失敗しました。商品登録は保持されています。再試行してください。';
};
export async function processExtraction(repo:ExtractionRepository,job:ExtractionJob,restageSecret:string){
 try{await repo.claim(job);}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return;throw e;}
 const prefix='procurement-sources/'+identityKey(job.identity)+'/',sources:NonNullable<ExtractionJob['sources']>=[];
 try{
  const inventory=await repo.inventory(job.identity.inventoryId),identity=inventory&&sourceIdentity(inventory);
  if(!inventory||inventory.deletedAt||!identity||identityKey(identity)!==identityKey(job.identity))throw Error('SOURCE_IDENTITY_CHANGED');
  let result:ExtractionResult;
  if(job.identity.provider==='YAHOO'){
   const html=await yahooDescriptionHtml(job.identity.externalId);result=extractDimensions(yahooDescription(html,job.identity));
   // Store only description evidence, not the whole page's account/navigation data.
   const key=prefix+result.source.hash+'/description.json';await repo.putObject(key,Buffer.from(JSON.stringify(result.source)),'application/json');sources.push({key,mime:'application/json',hash:result.source.hash});
  }else{
   const value=await new SecretsManagerClient({region:repo.config.region}).send(new GetSecretValueCommand({SecretId:restageSecret}));
   const credentials=JSON.parse(value.SecretString||'{}');if(typeof credentials.id!=='string'||typeof credentials.password!=='string')throw Error('RESTAGE_CREDENTIALS_INVALID');
   const client=new RestageHttp(credentials);await client.login();const sheets=await client.sheets(job.identity);
   if(!sheets.documents.length){await repo.finish(job,{state:'NO_SOURCE',sources:[],error:'出品表が見つかりません。通常の商品登録は完了しています。'});return;}
   // Multiple attachments may be continuations or different rows. Retain every
   // original, but do not infer their association or silently use the first.
   for(const doc of sheets.documents){const hash=sha(doc.bytes),key=prefix+hash+'/original.'+(doc.mime==='image/jpeg'?'jpg':'png');await repo.putObject(key,doc.bytes,doc.mime);sources.push({key,mime:doc.mime,hash});}
   if(sheets.documents.length!==1){await repo.finish(job,{state:'REVIEW',sources,error:'出品表が複数あります。対象行と続きの関係を原資料で確認してください。'});return;}
   const doc=sheets.documents[0],hash=sources[0].hash,cached=!job.force&&await repo.cached(job.identity,hash);
   if(cached){result=JSON.parse((await repo.object(cached)).toString());if(result.source.hash!==hash||result.version!==EXTRACTION_VERSION||identityKey(result.source.identity)!==identityKey(job.identity))throw Error('CACHE_INVALID');}
   else{
    const read=await readRestageSheet(doc.bytes,job.identity,doc.url);result=read.result;
    const evidenceKey=prefix+hash+'/'+job.revision+'-readings.json';await repo.putObject(evidenceKey,Buffer.from(JSON.stringify(read)),'application/json');
   }
  }
  const resultKey=prefix+result.source.hash+'/'+job.revision+'-result.json';await repo.putObject(resultKey,Buffer.from(JSON.stringify(result)),'application/json');
  await repo.cache(job,result.source.hash,resultKey);
  // Release gate: ALWAYS dry-run until held-out real-source evaluation is passed.
  // The worker has no Inventory write permission. Only explicit review can apply.
  const noDimensions=result.source.identity.provider==='YAHOO'&&result.state==='NO_DIMENSIONS';
  await repo.finish(job,{state:noDimensions?'NO_DIMENSIONS':'REVIEW',sources,resultKey,error:undefined});
 }catch(e){
  // Never log source text, credentials, cookies or the external error body.
  try{await repo.finish(job,{state:'FAILED',sources,error:errorText(e)});}catch(finishError){if((finishError as Error).name!=='ConditionalCheckFailedException')throw finishError;}
 }
}
