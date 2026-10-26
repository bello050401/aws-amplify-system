import {Stack,CfnOutput,RemovalPolicy} from 'aws-cdk-lib';
import {LogGroup,RetentionDays} from 'aws-cdk-lib/aws-logs';
import {CfnWebACL,CfnWebACLAssociation,CfnLoggingConfiguration} from 'aws-cdk-lib/aws-wafv2';

const sensitiveHeaders=['authorization','cookie','referer','x-api-key','x-amz-security-token','x-bello-device-proof','x-bello-server-grant','x-bello-data-gate','x-forwarded-for','x-real-ip','cloudfront-viewer-address'];
const visibility=(metricName:string)=>({cloudWatchMetricsEnabled:true,metricName,sampledRequestsEnabled:false});
const path=(value:string,position:'EXACTLY'|'STARTS_WITH'):CfnWebACL.StatementProperty=>({byteMatchStatement:{fieldToMatch:{uriPath:{}},searchString:value,positionalConstraint:position,textTransformations:[{priority:0,type:'NONE'}]}});
/** Shared Amplify apps need a host-scoped ACL: a staging rollout must never
 * rate-limit or log production users. Actual connection IP comes from WAF,
 * not an HTTP header asserted by a browser. */
export function addSecurityEdge(stack:Stack,o:{appArn:string;host:string;mode:'count'|'block';associate:boolean;logging:boolean}){
 if(stack.region!=='us-east-1'||!/^arn:aws:amplify:[a-z0-9-]+:\d{12}:apps\/[a-z0-9]+$/.test(o.appArn)||o.appArn.split(':')[4]!==stack.account)throw Error('Same-account Amplify app and us-east-1 required');
 if(!/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(o.host)||o.host.length>253||o.host.includes('..'))throw Error('One exact host required');
 if(!['count','block'].includes(o.mode))throw Error('Invalid edge mode');
 // Alternate spellings of the same HTTPS host must not bypass the rate limit.
 const host:CfnWebACL.StatementProperty={orStatement:{statements:[o.host,o.host+':443',o.host+'.',o.host+'.:443'].map(value=>({byteMatchStatement:{fieldToMatch:{singleHeader:{Name:'host'}},searchString:value,positionalConstraint:'EXACTLY',textTransformations:[{priority:0,type:'LOWERCASE'}]}}))}};
 const scoped=(statement:CfnWebACL.StatementProperty):CfnWebACL.StatementProperty=>({andStatement:{statements:[host,statement]}});
 const action=o.mode==='block'?{block:{}}:{count:{}};
 const acl=new CfnWebACL(stack,'LoginRateProtection',{scope:'CLOUDFRONT',defaultAction:{allow:{}},visibilityConfig:visibility('BelloEdge'),
  dataProtectionConfig:{dataProtections:[
   // WAF reserves source-IP headers and rejects field data-protection on
   // them. They are still redacted by the logging configuration below.
   {action:'SUBSTITUTION',field:{fieldType:'SINGLE_HEADER',fieldKeys:sensitiveHeaders.filter(h=>!['x-forwarded-for','x-real-ip','cloudfront-viewer-address'].includes(h))}},
   {action:'SUBSTITUTION',field:{fieldType:'QUERY_STRING'}},
   {action:'SUBSTITUTION',field:{fieldType:'BODY'}},
  ]},rules:[
   {name:'AuthenticationAudit',priority:0,action:{count:{}},statement:scoped(path('/api/security/','STARTS_WITH')),ruleLabels:[{name:'bello:security-audit'}],visibilityConfig:visibility('BelloAuthenticationAudit')},
   {name:'LoginBurst',priority:1,action,statement:{rateBasedStatement:{limit:120,aggregateKeyType:'IP',evaluationWindowSec:300,scopeDownStatement:scoped({orStatement:{statements:[path('/api/security/login','EXACTLY'),path('/api/security/finish','EXACTLY')]}})}},visibilityConfig:visibility('BelloLoginBurst')},
   {name:'ApiFlood',priority:2,action,statement:{rateBasedStatement:{limit:10000,aggregateKeyType:'IP',evaluationWindowSec:300,scopeDownStatement:scoped(path('/api/','STARTS_WITH'))}},visibilityConfig:visibility('BelloApiFlood')},
  ]});
 if(o.logging){
  const logs=new LogGroup(stack,'AuthenticationLogs',{logGroupName:'aws-waf-logs-bello-security-stage',retention:RetentionDays.THREE_MONTHS,removalPolicy:RemovalPolicy.RETAIN});
  new CfnLoggingConfiguration(stack,'AuthenticationLogging',{resourceArn:acl.attrArn,logDestinationConfigs:[logs.logGroupArn],
   redactedFields:[{queryString:{}},...sensitiveHeaders.map(name=>({singleHeader:{Name:name}}))],
   loggingFilter:{DefaultBehavior:'DROP',Filters:[{Behavior:'KEEP',Requirement:'MEETS_ALL',Conditions:[{LabelNameCondition:{LabelName:acl.attrLabelNamespace+'bello:security-audit'}}]}]}});
  new CfnOutput(stack,'LogGroup',{value:logs.logGroupName});
 }
 if(o.associate)new CfnWebACLAssociation(stack,'ApplicationAssociation',{resourceArn:o.appArn,webAclArn:acl.attrArn});
 new CfnOutput(stack,'AclArn',{value:acl.attrArn});new CfnOutput(stack,'Mode',{value:o.mode});new CfnOutput(stack,'ProtectedHost',{value:o.host});
 return acl;
}
