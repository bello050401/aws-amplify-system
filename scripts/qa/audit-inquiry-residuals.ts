// Read-only. Aggregate contact-bearing paths and backup/log metadata; never export customer content.
import {readFileSync,writeFileSync} from 'node:fs';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,ListObjectVersionsCommand,ListBucketsCommand} from '@aws-sdk/client-s3';
import {redactInquiryRecord,redactInquiryContacts} from '../../lib/messaging/contactPrivacy';
const dir='artifacts/sale-automation-20261108',audit=JSON.parse(readFileSync(dir+'/audit.json','utf8'));
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'})),s3=new S3Client({region:'us-west-2'});
const fields:Record<string,number>={},markers:Record<string,number>={};
function examine(value:unknown,path:string){
 if(typeof value==='string'){
  try{const j=JSON.parse(value);if(j&&typeof j==='object'){examine(j,path);return;}}catch{}
  const next=redactInquiryContacts(value);if(next!==value){fields[path]=(fields[path]??0)+1;for(const label of ['住所削除','連絡先削除','郵便番号削除'])markers[label]=(markers[label]??0)+(next.split('['+label+']').length-value.split('['+label+']').length);}
 }else if(Array.isArray(value))value.forEach(v=>examine(v,path+'[]'));
 else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value))examine(v,path+'.'+k);
}
async function main(){
 const types=['Conversation','Message','ReplyDraft','MercariOrderContext'];
 for(const meta of audit.tables.filter((t:{name:string})=>types.some(n=>t.name.startsWith(n+'-'))||t.name.includes('InquiryRuntime'))){
  let cursor:Record<string,unknown>|undefined;do{const page=await db.send(new ScanCommand({TableName:meta.name,ExclusiveStartKey:cursor,ConsistentRead:true}));
   for(const row of page.Items??[]){const next=redactInquiryRecord(row);for(const k of Object.keys(row))if(JSON.stringify(next[k])!==JSON.stringify(row[k]))examine(row[k],meta.name.split('-')[0]+'.'+k);}
   cursor=page.LastEvaluatedKey;
  }while(cursor);
 }
 const files=[];
 // Object names are not emitted, including old object versions.
 for(const b of (await s3.send(new ListBucketsCommand({}))).Buckets??[]){
  if(!b.Name||!/inventory|inquiry|bello/i.test(b.Name))continue;
  try{let cursor:string|undefined,version:string|undefined,count=0,deleted=0,bytes=0;
   do{const p=await s3.send(new ListObjectVersionsCommand({Bucket:b.Name,Prefix:'messaging/',KeyMarker:cursor,VersionIdMarker:version}));count+=p.Versions?.length??0;deleted+=p.DeleteMarkers?.length??0;bytes+=(p.Versions??[]).reduce((n,v)=>n+(v.Size??0),0);cursor=p.IsTruncated?p.NextKeyMarker:undefined;version=p.IsTruncated?p.NextVersionIdMarker:undefined;}while(cursor);
   files.push({bucket:b.Name,versions:count,deleteMarkers:deleted,bytes});
  }catch(e){files.push({bucket:b.Name,error:(e as Error).name});}
 }
 const report={at:new Date().toISOString(),fields,markers,files,pitr:audit.tables.filter((t:{name:string})=>types.some(n=>t.name.startsWith(n+'-'))||t.name.includes('InquiryRuntime')).map((t:{name:string;pitr:unknown})=>({table:t.name,pitr:t.pitr})),logGroups:audit.logs};
 writeFileSync(dir+'/contacts-residual-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({fields,markers,files}));
}
main().catch(e=>{console.error((e as Error).name);process.exitCode=1;});
