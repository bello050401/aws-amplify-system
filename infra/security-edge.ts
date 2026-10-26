/** Separate us-east-1 Amplify WAF. Synthesize first; no automatic association. */
import {App,Stack,CfnOutput} from 'aws-cdk-lib';
import {CfnWebACL,CfnWebACLAssociation} from 'aws-cdk-lib/aws-wafv2';
const app=new App();
const account=process.env.CDK_DEFAULT_ACCOUNT;
const target=process.env.SECURITY_AMPLIFY_APP_ARN;
const mode=process.env.SECURITY_EDGE_MODE??'count';
if(!account||!target||!/^arn:aws:amplify:[a-z0-9-]+:\d{12}:apps\/[a-z0-9]+$/.test(target)||target.split(':')[4]!==account)throw Error('Exact same-account Amplify app ARN required');
if(!['count','block'].includes(mode))throw Error('Invalid edge mode');
const stack=new Stack(app,'BelloSecurityEdge',{env:{account,region:'us-east-1'}});
const visibility=(metricName:string)=>({cloudWatchMetricsEnabled:true,metricName,sampledRequestsEnabled:false});
const match=(value:string,position:'EXACTLY'|'STARTS_WITH'):CfnWebACL.StatementProperty=>({byteMatchStatement:{fieldToMatch:{uriPath:{}},searchString:value,positionalConstraint:position,textTransformations:[{priority:0,type:'NONE'}]}});
const action=mode==='block'?{block:{}}:{count:{}};
const acl=new CfnWebACL(stack,'LoginRateProtection',{scope:'CLOUDFRONT',defaultAction:{allow:{}},visibilityConfig:visibility('BelloEdge'),rules:[
 {name:'LoginBurst',priority:0,action,statement:{rateBasedStatement:{limit:120,aggregateKeyType:'IP',evaluationWindowSec:300,scopeDownStatement:{orStatement:{statements:[match('/api/security/login','EXACTLY'),match('/api/security/finish','EXACTLY')]}}}},visibilityConfig:visibility('BelloLoginBurst')},
 {name:'ApiFlood',priority:1,action,statement:{rateBasedStatement:{limit:10000,aggregateKeyType:'IP',evaluationWindowSec:300,scopeDownStatement:match('/api/','STARTS_WITH')}},visibilityConfig:visibility('BelloApiFlood')},
]});
// Explicit flag prevents an ordinary synth/deploy from affecting all branches.
if(process.env.SECURITY_EDGE_ASSOCIATE==='yes')new CfnWebACLAssociation(stack,'ApplicationAssociation',{resourceArn:target,webAclArn:acl.attrArn});
new CfnOutput(stack,'AclArn',{value:acl.attrArn});new CfnOutput(stack,'Mode',{value:mode});
app.synth();
