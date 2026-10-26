import {CloudWatchLogsClient,FilterLogEventsCommand} from '@aws-sdk/client-cloudwatch-logs';
import {createEdgeAuditEnricher,type EdgeRecord} from './edgeAudit';
/** Runtime role may read only the configured WAF log group. No arbitrary log
 * identifier or query comes from the browser, and raw records are never returned. */
export function awsEdgeAuditEnricher(origin:string,group=process.env.SECURITY_EDGE_LOG_GROUP,region=process.env.SECURITY_EDGE_LOG_REGION){
 if(!group||!region)return undefined;
 if(!/^aws-waf-logs-bello-[a-z0-9-]+$/.test(group)||region!=='us-east-1')throw Error('Invalid dedicated edge audit configuration');
 const client=new CloudWatchLogsClient({region,maxAttempts:1});
 return createEdgeAuditEnricher(new URL(origin).hostname,async(ids,from,to)=>{
  const result=await client.send(new FilterLogEventsCommand({logGroupName:group,startTime:Math.floor(from),endTime:Math.floor(to),limit:100,
   filterPattern:'{ '+ids.map(id=>'$.httpRequest.requestId = "'+id+'"').join(' || ')+' }'}),{abortSignal:AbortSignal.timeout(1500)});
  const records:EdgeRecord[]=[];
  for(const event of result.events??[]){try{records.push(JSON.parse(event.message??''));}catch{/* Missing log is not verified evidence. */}}
  return records;
 });
}
