// Dry-run by default. Reports contain field counts / hashed keys, never original contact details.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DynamoDBClient,DescribeTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,UpdateCommand,GetCommand} from '@aws-sdk/lib-dynamodb';
import {redactInquiryRecord} from '../../lib/messaging/contactPrivacy';
const dir='artifacts/sale-automation-20261108',audit=JSON.parse(readFileSync(dir+'/audit.json','utf8'));
const raw=new DynamoDBClient({region:'us-west-2'}),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}});
const tables=audit.tables.filter((t:{name:string})=>/^(Conversation-|Message-|ReplyDraft-|MercariOrderContext-)|InquiryRuntime/.test(t.name)).map((t:{name:string})=>t.name);
const apply=process.argv.includes('--apply');
async function main(){
 const report:{at:string;mode:string;tables:unknown[];conflicts:number;remaining:number}={at:new Date().toISOString(),mode:apply?'APPLY':'DRY_RUN',tables:[],conflicts:0,remaining:0};
 for(const table of tables){
  const meta=await raw.send(new DescribeTableCommand({TableName:table})),keys=meta.Table!.KeySchema!.map(k=>k.AttributeName!);
  let cursor:Record<string,unknown>|undefined,rows=0,affected=0,changed=0,attachmentRows=0;const fields:Record<string,number>={},manifest:string[]=[];
  do{
   const page=await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:cursor,ConsistentRead:true,Limit:100}));
   for(const row of page.Items??[]){
    rows++;if(row.attachmentKey||row.attachmentStorageKey||row.attachments?.length)attachmentRows++;
    const next=redactInquiryRecord(row),diff=Object.keys(row).filter(k=>!keys.includes(k)&&JSON.stringify(row[k])!==JSON.stringify(next[k]));
    if(!diff.length)continue;affected++;diff.forEach(k=>fields[k]=(fields[k]??0)+1);
    const Key=Object.fromEntries(keys.map(k=>[k,row[k]]));manifest.push(createHash('sha256').update(JSON.stringify(Key)).digest('hex'));
    if(apply){
     const names:Record<string,string>={'#privacy':'contactRedactedAt'},values:Record<string,unknown>={':privacy':new Date().toISOString()};
     diff.forEach((k,i)=>{names['#f'+i]=k;values[':old'+i]=row[k];values[':new'+i]=next[k];});
     try{await db.send(new UpdateCommand({TableName:table,Key,UpdateExpression:'SET '+diff.map((_,i)=>`#f${i}=:new${i}`).join(',')+',#privacy=:privacy',ConditionExpression:diff.map((_,i)=>`#f${i}=:old${i}`).join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values}));
      const verified=(await db.send(new GetCommand({TableName:table,Key,ConsistentRead:true}))).Item;
      if(!verified||diff.some(k=>JSON.stringify(verified[k])!==JSON.stringify(next[k])))report.remaining++;else changed++;
     }catch(e){if((e as Error).name==='ConditionalCheckFailedException')report.conflicts++;else throw e;}
    }
   }cursor=page.LastEvaluatedKey;
  }while(cursor);
  const stat={table,rows,affected,changed,fields,attachmentRows,recordKeyHashes:manifest};report.tables.push(stat);console.log(JSON.stringify({...stat,recordKeyHashes:undefined}));
 }
 mkdirSync(dir,{recursive:true});writeFileSync(dir+'/'+(apply?'contacts-deletion':'contacts-dry-run')+'.json',JSON.stringify(report,null,2));
 if(report.conflicts||report.remaining)process.exitCode=2;
}
main().catch(e=>{console.error((e as Error).name);process.exitCode=1;});
