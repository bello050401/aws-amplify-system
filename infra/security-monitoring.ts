import {App,Stack,Duration,RemovalPolicy,CfnOutput} from 'aws-cdk-lib';
import {Bucket,BucketEncryption,BlockPublicAccess} from 'aws-cdk-lib/aws-s3';
import {Trail,ReadWriteType} from 'aws-cdk-lib/aws-cloudtrail';
import {PolicyStatement,Effect,AnyPrincipal,ServicePrincipal} from 'aws-cdk-lib/aws-iam';
import {LogGroup,RetentionDays,MetricFilter,FilterPattern} from 'aws-cdk-lib/aws-logs';
import {Alarm,TreatMissingData,ComparisonOperator} from 'aws-cdk-lib/aws-cloudwatch';
import {SnsAction} from 'aws-cdk-lib/aws-cloudwatch-actions';
import {Topic} from 'aws-cdk-lib/aws-sns';
import {SqsSubscription} from 'aws-cdk-lib/aws-sns-subscriptions';
import {Queue,QueueEncryption} from 'aws-cdk-lib/aws-sqs';
import {Key} from 'aws-cdk-lib/aws-kms';
import {CfnDetector} from 'aws-cdk-lib/aws-guardduty';
import {Rule,RuleTargetInput,EventField} from 'aws-cdk-lib/aws-events';
import {SnsTopic} from 'aws-cdk-lib/aws-events-targets';

/** Account monitoring only. No inventory/auth settings, EC or external messages. */
export function monitoring(stack:Stack){
 const bucket=new Bucket(stack,'AuditArchive',{encryption:BucketEncryption.S3_MANAGED,enforceSSL:true,blockPublicAccess:BlockPublicAccess.BLOCK_ALL,versioned:true,
  removalPolicy:RemovalPolicy.RETAIN,lifecycleRules:[{id:'AuditRetention',expiration:Duration.days(90),noncurrentVersionExpiration:Duration.days(1),abortIncompleteMultipartUploadAfter:Duration.days(1)},{id:'ExpiredMarkers',expiredObjectDeleteMarker:true}]});
 bucket.addToResourcePolicy(new PolicyStatement({effect:Effect.DENY,principals:[new AnyPrincipal()],actions:['s3:*'],resources:[bucket.bucketArn,bucket.arnForObjects('*')],
  conditions:{ArnLike:{'aws:PrincipalArn':[`arn:aws:iam::${stack.account}:role/BelloAmplifyStagingComputeRole`,`arn:aws:iam::${stack.account}:role/amplify-bellosecuritybusi-IsolatedHostingRuntime*`]}}}));
 const logs=new LogGroup(stack,'AuditEvents',{retention:RetentionDays.THREE_MONTHS,removalPolicy:RemovalPolicy.RETAIN});
 const trail=new Trail(stack,'ManagementAudit',{trailName:'bello-management-audit',bucket,isMultiRegionTrail:true,includeGlobalServiceEvents:true,
  enableFileValidation:true,managementEvents:ReadWriteType.ALL,sendToCloudWatchLogs:true,cloudWatchLogGroup:logs});
 // AWS-managed SNS keys cannot authorize CloudWatch/EventBridge publishers.
 // This key is dedicated to alerts; EventBridge does not support SourceArn
 // conditions on its KMS grant. Topic publishing is separately scoped.
 const alertKey=new Key(stack,'AlertKey',{enableKeyRotation:true,removalPolicy:RemovalPolicy.RETAIN});
 alertKey.addToResourcePolicy(new PolicyStatement({principals:[new ServicePrincipal('cloudwatch.amazonaws.com')],actions:['kms:Decrypt','kms:GenerateDataKey*'],resources:['*'],conditions:{StringEquals:{'aws:SourceAccount':stack.account},ArnLike:{'aws:SourceArn':`arn:aws:cloudwatch:${stack.region}:${stack.account}:alarm:bello-security-*`}}}));
 alertKey.addToResourcePolicy(new PolicyStatement({principals:[new ServicePrincipal('events.amazonaws.com')],actions:['kms:Decrypt','kms:GenerateDataKey*'],resources:['*']}));
 const topic=new Topic(stack,'SecurityAlerts',{displayName:'BELLO security alerts',masterKey:alertKey});
 topic.addToResourcePolicy(new PolicyStatement({principals:[new ServicePrincipal('cloudwatch.amazonaws.com')],actions:['sns:Publish'],resources:[topic.topicArn],conditions:{StringEquals:{'aws:SourceAccount':stack.account},ArnLike:{'aws:SourceArn':`arn:aws:cloudwatch:${stack.region}:${stack.account}:alarm:bello-security-*`}}}));
 const queue=new Queue(stack,'AlertEvidence',{encryption:QueueEncryption.SQS_MANAGED,enforceSSL:true,retentionPeriod:Duration.days(7),visibilityTimeout:Duration.minutes(1)});
 topic.addSubscription(new SqsSubscription(queue,{rawMessageDelivery:true}));
 const patterns={
  RootUse:'{ $.userIdentity.type = "Root" && $.eventType != "AwsServiceEvent" }',
  AuditChanged:'{ ($.eventSource = "cloudtrail.amazonaws.com" && ($.eventName = "StopLogging" || $.eventName = "DeleteTrail" || $.eventName = "UpdateTrail")) || ($.eventSource = "guardduty.amazonaws.com" && ($.eventName = "DeleteDetector" || $.eventName = "UpdateDetector")) }',
  PermissionChanged:'{ $.eventSource = "iam.amazonaws.com" && ($.eventName = "AttachRolePolicy" || $.eventName = "PutRolePolicy" || $.eventName = "CreateAccessKey" || $.eventName = "UpdateAssumeRolePolicy") }',
  ConsoleFailures:'{ $.eventName = "ConsoleLogin" && $.errorMessage = "Failed authentication" }',
 };
 const alarms:Alarm[]=[];
 for(const [name,pattern] of Object.entries(patterns)){
  const filter=new MetricFilter(stack,name+'Filter',{logGroup:logs,filterPattern:FilterPattern.literal(pattern),metricNamespace:'BELLO/Security',metricName:name,metricValue:'1'});
  const alarm=new Alarm(stack,name+'Alarm',{alarmName:'bello-security-'+name,metric:filter.metric({statistic:'Sum',period:Duration.minutes(5)}),threshold:name==='ConsoleFailures'?5:1,
   evaluationPeriods:1,comparisonOperator:ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,treatMissingData:TreatMissingData.NOT_BREACHING});
  alarm.addAlarmAction(new SnsAction(topic));alarms.push(alarm);
 }
 // Foundational detection only. Optional high-volume protections are explicit
 // opt-ins, not silently enabled during account registration.
 const detector=new CfnDetector(stack,'ThreatDetection',{enable:true,findingPublishingFrequency:'FIFTEEN_MINUTES',features:
  ['S3_DATA_EVENTS','EKS_AUDIT_LOGS','EBS_MALWARE_PROTECTION','RDS_LOGIN_EVENTS','LAMBDA_NETWORK_LOGS','RUNTIME_MONITORING','AI_PROTECTION','AI_ANALYST'].map(name=>({name,status:'DISABLED'}))});
 const finding=new Rule(stack,'ThreatAlert',{eventPattern:{source:['aws.guardduty'],detailType:['GuardDuty Finding'],detail:{severity:[{numeric:['>=',4]}]}},
 });
 finding.addTarget(new SnsTopic(topic,{message:RuleTargetInput.fromObject({source:'GuardDuty',type:EventField.fromPath('$.detail.type'),severity:EventField.fromPath('$.detail.severity'),findingId:EventField.fromPath('$.detail.id'),region:EventField.region,time:EventField.time})}));
 for(const [name,value] of Object.entries({TrailArn:trail.trailArn,Bucket:bucket.bucketName,LogGroup:logs.logGroupName,TopicArn:topic.topicArn,QueueUrl:queue.queueUrl,DetectorId:detector.ref,TestAlarm:alarms[0].alarmName}))new CfnOutput(stack,name,{value});
 return{bucket,logs,trail,topic,queue,detector,alarms};
}
if(require.main===module){
 if(process.env.AWS_REGION!=='us-west-2'||process.env.CDK_DEFAULT_REGION!=='us-west-2'||process.env.CDK_DEFAULT_ACCOUNT!=='203918843421')throw Error('Explicit monitoring account and region required');
 const app=new App();monitoring(new Stack(app,'BelloSecurityMonitoring',{env:{account:'203918843421',region:'us-west-2'}}));app.synth();
}
