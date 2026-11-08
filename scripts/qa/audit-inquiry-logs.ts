import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CloudWatchLogsClient,FilterLogEventsCommand} from '@aws-sdk/client-cloudwatch-logs';
import {redactInquiryContacts} from '../../lib/messaging/contactPrivacy';
const dir='artifacts/sale-automation-20261108',audit=JSON.parse(readFileSync(dir+'/audit.json','utf8'));
async function main(){const client=new CloudWatchLogsClient({region:'us-west-2'}),reports=[];
 for(const g of audit.logs.filter((x:{name:string})=>x.name==='/aws/amplify/d4hkkg7dty2du'||/Worker11F36D0F|purchasenotificationsloggroup|yahoopaymentreconcilerloggroup/.test(x.name))){
  let nextToken:string|undefined,count=0,pages=0;const hits:unknown[]=[];
  const startTime=Date.now()-(g.retention??30)*86400000;
  do{const p=await client.send(new FilterLogEventsCommand({logGroupName:g.name,startTime,nextToken,limit:10000}));
   for(const e of p.events??[]){count++;const message=(e.message??'').replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{32,64}\b/gi,'[IDENTIFIER]');if(message&&redactInquiryContacts(message)!==message)hits.push({eventHash:createHash('sha256').update(e.eventId??'').digest('hex'),timestamp:e.timestamp,stream:e.logStreamName});}
   if(p.nextToken===nextToken)break;nextToken=p.nextToken;
  }while(nextToken&&++pages<250);
  reports.push({group:g.name,retentionDays:g.retention,count,complete:!nextToken,potentialContacts:hits});console.log(JSON.stringify({group:g.name,count,potentialContacts:hits.length,complete:!nextToken}));
 }
 writeFileSync(dir+'/contacts-log-audit.json',JSON.stringify({at:new Date().toISOString(),reports},null,2));
}
main().catch(e=>{console.error((e as Error).name);process.exitCode=1;});
