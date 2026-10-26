// AWS-provided sample finding only: no attack, EC2 launch or outside notification.
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const aws=process.env.AWS_CLI||'C:/Program Files/Amazon/AWSCLIV2/aws.exe',dir='artifacts/security-20261026';
const c=JSON.parse(fs.readFileSync(dir+'/monitoring-outputs.json','utf8')).BelloSecurityMonitoring;
const type='Backdoor:EC2/DenialOfService.Tcp',started=Date.now();
function cli(service,command,args=[]){const s=execFileSync(aws,[service,command,...args,'--region','us-west-2','--profile','Bello','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});return s.trim()?JSON.parse(s):{}}
async function main(){
 assert.equal(cli('sts','get-caller-identity').Account,'203918843421');assert(c.QueueUrl.includes('BelloSecurityMonitoring-'));
 assert(cli('sns','list-subscriptions-by-topic',['--topic-arn',c.TopicArn]).Subscriptions.every(s=>s.Protocol==='sqs'));
 cli('guardduty','create-sample-findings',['--detector-id',c.DetectorId,'--finding-types',type]);
 let notification;
 for(let i=0;i<24&&!notification;i++){
  const messages=cli('sqs','receive-message',['--queue-url',c.QueueUrl,'--wait-time-seconds','5','--max-number-of-messages','10']).Messages||[];
  for(const m of messages){let n;try{n=JSON.parse(m.Body)}catch{continue}if(n.source==='GuardDuty'&&n.type===type&&Date.parse(n.time)>=started-60000){notification=n;cli('sqs','delete-message',['--queue-url',c.QueueUrl,'--receipt-handle',m.ReceiptHandle]);break;}else cli('sqs','change-message-visibility',['--queue-url',c.QueueUrl,'--receipt-handle',m.ReceiptHandle,'--visibility-timeout','0']);}
 }
 assert(notification,'GuardDuty sample must arrive via EventBridge and encrypted SNS');
 assert.deepEqual(Object.keys(notification).sort(),['findingId','region','severity','source','time','type']);assert(notification.severity>=4);
 const f=cli('guardduty','get-findings',['--detector-id',c.DetectorId,'--finding-ids',notification.findingId]).Findings[0];
 // [SAMPLE] is a console decoration, not part of the API title. The official
 // AdditionalInfo flag is the machine-readable proof that this is synthetic.
 assert.equal(JSON.parse(f.Service.AdditionalInfo.Value).sample,true);assert.equal(f.Type,type);assert(Date.parse(f.UpdatedAt)>=started-60000);
 // Archive only this newly created official sample, never actual findings.
 cli('guardduty','archive-findings',['--detector-id',c.DetectorId,'--finding-ids',f.Id]);
 assert.equal(cli('guardduty','get-findings',['--detector-id',c.DetectorId,'--finding-ids',f.Id]).Findings[0].Service.Archived,true);
 const result={at:new Date().toISOString(),passed:3,failed:0,results:['Official sample finding delivered through EventBridge and encrypted SNS','Only six metadata fields in alert payload','Only this sample finding archived after verification'],noExternalRecipients:true,realAttackTest:false};
 fs.writeFileSync(dir+'/threat-alert-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});
