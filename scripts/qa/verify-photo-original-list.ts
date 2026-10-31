import assert from 'node:assert/strict';
import {BatchGetCommand,QueryCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import {readPhotoRows,photoRowKey} from '../../lib/photoRegistration/batchRead';
import {TemporaryOriginals} from '../../lib/photoRegistration/temporaryOriginals';
import {assetKey,batchKey} from '../../lib/photoRegistration/keys';
async function main(){
 const a={PK:'p',SK:'a'},b={PK:'p',SK:'b'};let calls=0;const delays:number[]=[];
 const db={send:async(c:any)=>{assert(c instanceof BatchGetCommand);assert(c.input.RequestItems?.t.ConsistentRead);calls++;return calls===1?{Responses:{t:[a]},UnprocessedKeys:{t:{Keys:[b]}}}:{Responses:{t:[b]}};}} as Pick<DynamoDBDocumentClient,'send'>;
 const found=await readPhotoRows(db,'t',[a,a,b],async ms=>{delays.push(ms);});assert.equal(found.size,2);assert.equal(calls,2);assert.deepEqual(delays,[50]);
 await assert.rejects(readPhotoRows({send:async()=>({UnprocessedKeys:{t:{Keys:[a]}}})} as any,'t',[a],async()=>{}),/INCOMPLETE/);
 await assert.rejects(readPhotoRows({send:async()=>({Responses:{t:[{PK:'unexpected',SK:'a'}]}})} as any,'t',[a]),/UNEXPECTED_ROW/);
 assert.equal((await readPhotoRows({send:async()=>({Responses:{t:[]}})} as any,'t',[a])).size,0);
 const now=Date.now(),records=new Map<string,any>(),imports:any[]=[];
 for(let i=0;i<200;i++){
  const ref={id:'asset'+i,batchId:'batch'+i,sequence:0};imports.push({id:'import'+i,assetRef:ref});
  const a=assetKey(ref.batchId,0,ref.id),b=batchKey(ref.batchId);
  records.set(photoRowKey(a),{...a,id:ref.id,original:{key:'key'+i,uploadedAt:new Date(now).toISOString(),expiresAt:'',retentionPolicy:'PRODUCT_LINK'}});
  records.set(photoRowKey(b),{...b,linkedAt:new Date(now).toISOString()});
 }
 let reads=0;const listDb={send:async(c:any)=>{reads++;if(c instanceof QueryCommand)return {Items:imports};assert(c instanceof BatchGetCommand);const keys=c.input.RequestItems?.t.Keys;assert(keys && keys.length<=100);return {Responses:{t:keys.map((k:any)=>records.get(photoRowKey(k)))}};}} as DynamoDBDocumentClient;
 const service=new TemporaryOriginals({db:listDb,s3:{} as S3Client,table:'t',bucket:'test',auth:{photoDeviceGroupDeployed:true},now:()=>now});
 const list=await service.list();assert.equal(list.length,200);assert(list.every(x=>x.available));assert.equal(reads,5);
 console.log(JSON.stringify({pass:true,originals:200,ddbCalls:reads,previousDdbCalls:203,deduplication:true,unprocessedRetry:true,incompleteReadFails:true,missingRowsDistinct:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
