// Verifies this task's monitoring resources. No customer/user notification.
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const aws=process.env.AWS_CLI||'C:/Program Files/Amazon/AWSCLIV2/aws.exe';
const dir='artifacts/security-20261026',output=JSON.parse(fs.readFileSync(dir+'/monitoring-outputs.json','utf8')).BelloSecurityMonitoring;
const results=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
function cli(service,command,args=[]){const value=execFileSync(aws,[service,command,...args,'--region','us-west-2','--profile','Bello','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});return value.trim()?JSON.parse(value):{}}
function pass(name){results.push({name,result:'PASS'});console.log('PASS '+name)}
function save(extra={}){fs.writeFileSync(dir+'/monitoring-live-results.json',JSON.stringify({at:new Date().toISOString(),results,emailDelivery:'NOT_TESTED_NO_SUBSCRIBER',productionAuthenticationChanged:false,scope:'CloudTrail multi-region management; GuardDuty us-west-2 foundational',...extra},null,2))}
async function main(){
 assert.equal(cli('sts','get-caller-identity').Account,'203918843421');assert(output.TrailArn.endsWith(':trail/bello-management-audit'));assert(output.QueueUrl.includes('BelloSecurityMonitoring-'));
 const subscriptions=cli('sns','list-subscriptions-by-topic',['--topic-arn',output.TopicArn]).Subscriptions;assert.equal(subscriptions.length,1);assert.equal(subscriptions[0].Protocol,'sqs');pass('No external or email recipients configured');
 const trail=cli('cloudtrail','get-trail',['--name',output.TrailArn]).Trail;assert(trail.IsMultiRegionTrail&&trail.LogFileValidationEnabled);assert.equal(trail.S3BucketName,output.Bucket);
 const status=cli('cloudtrail','get-trail-status',['--name',output.TrailArn]);assert(status.IsLogging);assert(!status.LatestDeliveryError);assert(!status.LatestCloudWatchLogsDeliveryError);pass('Management trail is logging with file integrity validation enabled');
 const selectors=cli('cloudtrail','get-event-selectors',['--trail-name',output.TrailArn]).EventSelectors;assert(selectors.every(s=>s.IncludeManagementEvents&&s.ReadWriteType==='All'&&!s.DataResources?.length));pass('Management events only; no S3 object or DynamoDB record logging');
 const detector=cli('guardduty','get-detector',['--detector-id',output.DetectorId]);assert.equal(detector.Status,'ENABLED');
 const foundational=['CLOUD_TRAIL','DNS_LOGS','FLOW_LOGS'];
 assert(foundational.every(name=>detector.Features.some(f=>f.Name===name&&f.Status==='ENABLED')));
 assert(detector.Features.filter(f=>!foundational.includes(f.Name)).every(f=>f.Status==='DISABLED'));pass('Foundational threat detection active without optional protections');
 const encryption=cli('s3api','get-bucket-encryption',['--bucket',output.Bucket]);assert.equal(encryption.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm,'AES256');
 assert(Object.values(cli('s3api','get-public-access-block',['--bucket',output.Bucket]).PublicAccessBlockConfiguration).every(Boolean));assert.equal(cli('s3api','get-bucket-versioning',['--bucket',output.Bucket]).Status,'Enabled');pass('Audit archive encryption, public block and versioning active');
 const lifecycle=cli('s3api','get-bucket-lifecycle-configuration',['--bucket',output.Bucket]).Rules.find(r=>r.ID==='AuditRetention');assert.equal(lifecycle.Expiration.Days,90);assert.equal(lifecycle.NoncurrentVersionExpiration.NoncurrentDays,1);pass('Archive and past-version expiration are bounded');
 const reason='BELLO isolated internal alert verification '+Date.now();let received=false;
 // Confirm zero external subscribers immediately before the synthetic action.
 assert(cli('sns','list-subscriptions-by-topic',['--topic-arn',output.TopicArn]).Subscriptions.every(s=>s.Protocol==='sqs'));
 try{
  cli('cloudwatch','set-alarm-state',['--alarm-name',output.TestAlarm,'--state-value','OK','--state-reason',reason+' prepare']);
  cli('cloudwatch','set-alarm-state',['--alarm-name',output.TestAlarm,'--state-value','ALARM','--state-reason',reason]);
  for(let i=0;i<12&&!received;i++){
   const messages=cli('sqs','receive-message',['--queue-url',output.QueueUrl,'--wait-time-seconds','5','--max-number-of-messages','10']).Messages||[];
   for(const m of messages){let data;try{data=JSON.parse(m.Body)}catch{continue}if(data.AlarmName===output.TestAlarm&&data.NewStateReason===reason){received=true;cli('sqs','delete-message',['--queue-url',output.QueueUrl,'--receipt-handle',m.ReceiptHandle]);}else cli('sqs','change-message-visibility',['--queue-url',output.QueueUrl,'--receipt-handle',m.ReceiptHandle,'--visibility-timeout','0']);}
  }
  assert(received,'Encrypted CloudWatch → SNS → internal queue alert must arrive');pass('Actual encrypted alarm delivery received internally; no email sent');
 }finally{cli('cloudwatch','set-alarm-state',['--alarm-name',output.TestAlarm,'--state-value','OK','--state-reason',reason+' complete']);}
 save();
 // CloudTrail delivery is asynchronous. Never count configuration as delivery.
 let delivery;
 for(let i=0;i<12;i++){
  delivery=cli('cloudtrail','get-trail-status',['--name',output.TrailArn]);
  if(delivery.LatestDeliveryTime&&delivery.LatestCloudWatchLogsDeliveryTime)break;
  await delay(10000);
 }
 if(delivery.LatestDeliveryTime&&delivery.LatestCloudWatchLogsDeliveryTime){assert(!delivery.LatestDeliveryError&&!delivery.LatestCloudWatchLogsDeliveryError);pass('Management records delivered to both S3 and CloudWatch');}
 else results.push({name:'Management records delivered to both S3 and CloudWatch',result:'PENDING_DELIVERY'});
 save({delivery:{s3:delivery.LatestDeliveryTime||null,cloudWatch:delivery.LatestCloudWatchLogsDeliveryTime||null},signedDigestVerification:'NOT_YET_VERIFIED'});
 console.log(JSON.stringify({passed:results.filter(r=>r.result==='PASS').length,pending:results.filter(r=>r.result!=='PASS').length,failed:0}));
}
main().catch(e=>{results.push({name:'Live monitoring verification',result:'FAIL',error:e.name+': '+(e.message||'').slice(0,500)});save();console.error(e.name+': '+e.message);process.exitCode=1});
