import assert from 'node:assert/strict';
import {App,Stack} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {UserPool,CfnUserPool} from 'aws-cdk-lib/aws-cognito';
import {Role,ServicePrincipal} from 'aws-cdk-lib/aws-iam';
import {GraphqlApi,AuthorizationType,SchemaFile} from 'aws-cdk-lib/aws-appsync';
import {Bucket} from 'aws-cdk-lib/aws-s3';
import {addDeviceResources} from '../amplify/security/deviceResources';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {settings}=require('./security-runtime-environment.cjs');
let passed=0;
function test(name:string,fn:()=>void){fn();passed++;console.log('PASS '+name);}
function fixture(phase:'prepare'|'enforced'){
 const app=new App(),auth=new Stack(app,'Auth'),data=new Stack(app,'Data'),storage=new Stack(app,'Storage');
 const pool=new UserPool(auth,'ExistingPool',{selfSignUpEnabled:false});
 const old=pool.addClient('ExistingBrowserClient');
 const cfn=pool.node.defaultChild as CfnUserPool;
 const password={minimumLength:12,requireNumbers:true};cfn.policies={passwordPolicy:password};cfn.mfaConfiguration='OFF';
 const api=new GraphqlApi(data,'ExistingData',{name:'fixture',schema:SchemaFile.fromAsset('infra/security-pilot.graphql'),authorizationConfig:{defaultAuthorization:{authorizationType:AuthorizationType.API_KEY}}});
 const bucket=new Bucket(storage,'ExistingBucket');
 const identity=new Role(auth,'IdentityRole',{assumedBy:new ServicePrincipal('cognito-identity.amazonaws.com')});
 const runtime=Role.fromRoleArn(auth,'WebRuntime','arn:aws:iam::111122223333:role/TestRuntime');
 const result=addDeviceResources({stack:auth,pool,cfnPool:cfn,api:api.node.defaultChild as any,bucket,runtime,identityRoles:[identity],phase,origin:'https://security.example.com',recoveryOperatorArn:'arn:aws:iam::111122223333:user/RecoveryOperator'});
 return{app,auth,data,storage,pool,cfn,old,result,password};
}
test('Preparation preserves existing user pool/password/MFA/browser client',()=>{
 const f=fixture('prepare');assert.deepEqual((f.cfn.policies as any).passwordPolicy,f.password);assert.equal(f.cfn.mfaConfiguration,'OFF');
 const t=Template.fromStack(f.auth);t.resourceCountIs('AWS::Cognito::UserPool',1);t.resourceCountIs('AWS::Cognito::UserPoolClient',2);
 Template.fromStack(f.data).resourceCountIs('AWS::WAFv2::WebACL',0);Template.fromStack(f.storage).resourceCountIs('AWS::S3::BucketPolicy',0);
 f.app.synth();
});
test('Enforcement builds without cross-stack cycles and blocks direct data paths',()=>{
 const f=fixture('enforced');const t=Template.fromStack(f.data);t.resourceCountIs('AWS::WAFv2::WebACLAssociation',1);
 t.hasResourceProperties('AWS::WAFv2::WebACL',{DefaultAction:{Block:{}},VisibilityConfig:{SampledRequestsEnabled:false,CloudWatchMetricsEnabled:true,MetricName:'BelloDeviceDataBoundary'}});
 const policy=JSON.stringify(Template.fromStack(f.storage).toJSON());assert(policy.includes('Deny'));assert(policy.includes('aws:PrincipalArn'));
 f.app.synth();
});
test('Server sessions and key storage retained; refresh rotates',()=>{
 const f=fixture('prepare'),t=Template.fromStack(f.auth);
 t.hasResourceProperties('AWS::Cognito::UserPoolClient',{GenerateSecret:true,RefreshTokenRotation:{Feature:'ENABLED',RetryGracePeriodSeconds:10},AccessTokenValidity:5});
 t.hasResourceProperties('AWS::KMS::Key',{EnableKeyRotation:true});
 t.hasResourceProperties('AWS::DynamoDB::Table',{DeletionProtectionEnabled:true,TimeToLiveSpecification:{AttributeName:'expiresAt',Enabled:true}});
});
test('Legacy deployment exports no security credentials or forced migration',()=>assert.deepEqual(settings({},{}),{BELLO_DEVICE_SECURITY:'legacy'}));
test('Recovery requires MFA and cannot change users or access business data',()=>{
 const f=fixture('prepare'),r=Template.fromStack(f.auth).toJSON().Resources;
 const role=Object.values(r).find((v:any)=>v.Type==='AWS::IAM::Role'&&v.Properties.Description?.startsWith('Emergency')) as any;
 assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.Bool['aws:MultiFactorAuthPresent'],'true');
 const policies=Object.values(r).filter((v:any)=>v.Type==='AWS::IAM::Policy'&&JSON.stringify(v.Properties.Roles).includes('DeviceRecoveryOperator')) as any[];
 assert.equal(policies.length,1);const statements=policies[0].Properties.PolicyDocument.Statement;
 assert(statements.every((s:any)=>['dynamodb:GetItem','dynamodb:PutItem'].includes(s.Action)));
 const writes=statements.find((s:any)=>s.Action==='dynamodb:PutItem');
 assert.deepEqual(writes.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'],['device#*','event#*']);
});
test('Enforcement fails if infrastructure absent or mismatched',()=>assert.throws(()=>settings({BELLO_DEVICE_SECURITY:'enforced'},{})));
test('Server env exports identifiers only, never secret values',()=>{
 const c={phase:'enforced',origin:'https://security.example.com',region:'us-west-2',table:'t',keyArn:'k',deployment:'d',poolId:'p',clientId:'c',clientSecretArn:'s',dataGateSecretArn:'g',clientSecret:'must-not-copy'};
 const r=settings({BELLO_DEVICE_SECURITY:'enforced',SECURITY_ORIGIN:c.origin},{custom:{deviceSecurity:c}});
 assert(!JSON.stringify(r).includes('must-not-copy'));assert(!Object.keys(r).some(k=>k.startsWith('NEXT_PUBLIC')));assert.equal(r.SECURITY_ORIGIN,c.origin);
});
console.log(JSON.stringify({passed,failed:0,deployed:false}));
