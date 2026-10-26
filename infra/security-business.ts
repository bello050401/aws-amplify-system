/** Isolated copy of BELLO's real schema; NO schedules, external integrations or production tables. */
import {defineBackend} from '@aws-amplify/backend';
import {App,Stack,CfnOutput,RemovalPolicy,SecretValue,Token} from 'aws-cdk-lib';
import {Table,AttributeType,BillingMode} from 'aws-cdk-lib/aws-dynamodb';
import {Effect,PolicyStatement,AnyPrincipal,Role,ArnPrincipal,ServicePrincipal} from 'aws-cdk-lib/aws-iam';
import {Secret} from 'aws-cdk-lib/aws-secretsmanager';
import {addDeviceResources} from '../amplify/security/deviceResources';
import {CfnWebACL,CfnWebACLAssociation} from 'aws-cdk-lib/aws-wafv2';
import {CfnResolver,CfnFunctionConfiguration} from 'aws-cdk-lib/aws-appsync';
import {auth} from '../amplify/auth/resource';
import {data} from '../amplify/data/resource';
import {storage} from '../amplify/storage/resource';
import {generateSku} from '../amplify/functions/generate-sku/resource';
import fs from 'node:fs';

process.env.CDK_CONTEXT_JSON=JSON.stringify({'amplify-backend-namespace':'bello-security-business','amplify-backend-name':'20261026','amplify-backend-type':'sandbox'});
// Amplify reads AWS_REGION independently from CDK's default. Fail before any
// assets are deployed if the operator/profile selects a different environment.
if(process.env.AWS_REGION!=='us-west-2'||process.env.CDK_DEFAULT_REGION!=='us-west-2'||process.env.CDK_DEFAULT_ACCOUNT!=='203918843421')throw Error('Set the isolated account and AWS_REGION=us-west-2 explicitly');
const pilot=JSON.parse(fs.readFileSync('cdk.out/security/pilot-outputs.json','utf8')).BelloSecurityPilot20261026;
if(pilot.PoolId!=='us-west-2_JUoq4susA')throw Error('Only the isolated pilot identity may be used');
const backend=defineBackend({auth,data,storage,generateSku});
const api=backend.data.resources.graphqlApi;
const cfnApi=backend.data.resources.cfnResources.cfnGraphqlApi;
// Gen2 uses API_KEY as the default for public CMS data. Cognito is therefore
// an additional provider; setting the default's userPoolConfig is ignored.
cfnApi.additionalAuthenticationProviders=[
 {authenticationType:'AMAZON_COGNITO_USER_POOLS',userPoolConfig:{userPoolId:pilot.PoolId,awsRegion:'us-west-2',appIdClientRegex:pilot.ClientId}},
 {authenticationType:'AWS_IAM'},
];
const gateStack=Stack.of(api);
const acl=new CfnWebACL(gateStack,'SecurityOriginGate',{scope:'REGIONAL',defaultAction:{block:{}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloStageOrigin',sampledRequestsEnabled:false},rules:[{name:'ServerOnly',priority:0,action:{allow:{}},statement:{byteMatchStatement:{fieldToMatch:{singleHeader:{Name:'x-bello-data-gate'}},positionalConstraint:'EXACTLY',searchString:SecretValue.secretsManager(pilot.DataGateSecretArn,{jsonField:'value'}).unsafeUnwrap(),textTransformations:[{priority:0,type:'NONE'}]}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloStageOriginAllowed',sampledRequestsEnabled:false}}]});
new CfnWebACLAssociation(gateStack,'SecurityOriginGateAssociation',{resourceArn:cfnApi.attrArn,webAclArn:acl.attrArn});
// Explicit deny overrides previously issued Identity Pool credentials as well.
const authResources=backend.auth.resources;
const identityRoles=[authResources.authenticatedUserIamRole,authResources.unauthenticatedUserIamRole,...Object.values(authResources.groups).map(g=>g.role)];
backend.storage.resources.bucket.addToResourcePolicy(new PolicyStatement({effect:Effect.DENY,principals:[new AnyPrincipal()],actions:['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:DeleteObject','s3:DeleteObjectVersion'],resources:[backend.storage.resources.bucket.arnForObjects('*')],conditions:{ArnEquals:{'aws:PrincipalArn':identityRoles.map(r=>r.roleArn)}}}));
const skuStack=backend.createStack('SkuCounterStack');
const counter=new Table(skuStack,'Counter',{partitionKey:{name:'id',type:AttributeType.STRING},billingMode:BillingMode.PAY_PER_REQUEST,removalPolicy:RemovalPolicy.RETAIN});
counter.grantReadWriteData(backend.generateSku.resources.lambda);backend.generateSku.addEnvironment('SKU_COUNTER_TABLE_NAME',counter.tableName);
const root=Stack.of(backend.auth.resources.userPool).nestedStackParent ?? Stack.of(backend.auth.resources.userPool);
// Gen2's default stack is environment-agnostic. The CLI must resolve it using
// the explicit environment guarded above, never the profile's default region.
if((!Token.isUnresolved(root.region)&&root.region!=='us-west-2')||(!Token.isUnresolved(root.account)&&root.account!=='203918843421'))throw Error('Unexpected isolated deployment target');
new CfnOutput(root,'IsolatedGraphqlUrl',{value:cfnApi.attrGraphQlUrl});new CfnOutput(root,'IsolatedBucket',{value:backend.storage.resources.bucket.bucketName});
new CfnOutput(root,'IsolatedTables',{value:JSON.stringify(Object.fromEntries(Object.entries(backend.data.resources.tables).map(([name,t])=>[name,t.tableName])))});
// Local browser regression receives only this role, so fallback credential
// loaders cannot reach production secrets even if a settings page is opened.
const testRole=new Role(root,'IsolatedBrowserRuntime',{assumedBy:new ArnPrincipal('arn:aws:iam::203918843421:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_AdministratorAccess_7f27e4ccbf53b994')});
testRole.addToPolicy(new PolicyStatement({actions:['cognito-idp:AdminCreateUser','cognito-idp:AdminSetUserPassword','cognito-idp:AdminAddUserToGroup','cognito-idp:AdminDisableUser'],resources:['arn:aws:cognito-idp:us-west-2:203918843421:userpool/'+pilot.PoolId]}));
const pilotTableArns=[pilot.Table,pilot.FixturePhotoTable].map(n=>'arn:aws:dynamodb:us-west-2:203918843421:table/'+n);
// Gen2 includes the unique API ID in every generated table name. Scope to
// this exact isolated API instead of exceeding IAM's policy-size limit by
// repeating 63 full table ARNs and their indexes.
const dataTableArns=[root.formatArn({service:'dynamodb',resource:'table',resourceName:'*-'+api.apiId+'-NONE'})];
testRole.addToPolicy(new PolicyStatement({actions:['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem','dynamodb:Query','dynamodb:Scan'],resources:[...pilotTableArns,...dataTableArns,...[...pilotTableArns,...dataTableArns].map(n=>n+'/index/*')]}));
testRole.addToPolicy(new PolicyStatement({actions:['secretsmanager:GetSecretValue'],resources:[pilot.SecretArn,pilot.DataGateSecretArn]}));
testRole.addToPolicy(new PolicyStatement({actions:['kms:GenerateDataKey','kms:Decrypt'],resources:[pilot.KeyArn]}));
testRole.addToPolicy(new PolicyStatement({actions:['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:DeleteObject','s3:DeleteObjectVersion'],resources:[backend.storage.resources.bucket.arnForObjects('*'),'arn:aws:s3:::'+pilot.FixturePhotoBucket+'/*']}));
testRole.addToPolicy(new PolicyStatement({actions:['s3:ListBucket','s3:ListBucketVersions','s3:GetBucketVersioning'],resources:[backend.storage.resources.bucket.bucketArn,'arn:aws:s3:::'+pilot.FixturePhotoBucket]}));
new CfnOutput(root,'IsolatedBrowserRoleArn',{value:testRole.roleArn});
// Full HTTPS staging, separate from production identities and SSR permissions.
// Keep the existing private AppSync gate and S3 deny above; the factory's
// preparation phase adds only identity/session resources to this already gated API.
if(process.env.SECURITY_HOSTED_STAGE==='true'){
 const origin='https://codex-security-20261026.d4hkkg7dty2du.amplifyapp.com';
 const role=new Role(root,'IsolatedHostingRuntime',{assumedBy:new ServicePrincipal('amplify.amazonaws.com').withConditions({StringEquals:{'aws:SourceAccount':'203918843421'},ArnEquals:{'aws:SourceArn':'arn:aws:amplify:us-west-2:203918843421:apps/d4hkkg7dty2du'}})});
 const resources=addDeviceResources({stack:Stack.of(authResources.userPool),pool:authResources.userPool,cfnPool:authResources.cfnResources.cfnUserPool,
  api:cfnApi,bucket:backend.storage.resources.bucket,runtime:role,identityRoles,origin,phase:'prepare',
  existingDataGate:Secret.fromSecretCompleteArn(root,'ExistingStageDataGate',pilot.DataGateSecretArn)});
 // Both isolated test identities are supported; neither provider is production.
 cfnApi.additionalAuthenticationProviders=[...(cfnApi.additionalAuthenticationProviders as any[]),{
  authenticationType:'AMAZON_COGNITO_USER_POOLS',userPoolConfig:{userPoolId:authResources.userPool.userPoolId,awsRegion:'us-west-2',appIdClientRegex:resources.client.ref}}];
 authResources.cfnResources.cfnUserPool.adminCreateUserConfig={allowAdminCreateUserOnly:true};
 authResources.cfnResources.cfnUserPool.deletionProtection='ACTIVE';
 const config={...resources.configuration,phase:'enforced',region:'us-west-2',deployment:'bello-security-hosted-20261026'};
 backend.addOutput({custom:{deviceSecurity:config}});
 new CfnOutput(root,'HostedSecurity',{value:JSON.stringify(config)});
 new CfnOutput(root,'IsolatedHostingRoleArn',{value:role.roleArn});
 role.addToPolicy(new PolicyStatement({actions:['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem','dynamodb:Query','dynamodb:Scan'],resources:[...dataTableArns,...dataTableArns.map(n=>n+'/index/*'),'arn:aws:dynamodb:us-west-2:203918843421:table/'+pilot.FixturePhotoTable,'arn:aws:dynamodb:us-west-2:203918843421:table/'+pilot.FixturePhotoTable+'/index/*']}));
 role.addToPolicy(new PolicyStatement({actions:['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:DeleteObject','s3:DeleteObjectVersion'],resources:[backend.storage.resources.bucket.arnForObjects('*'),'arn:aws:s3:::'+pilot.FixturePhotoBucket+'/*']}));
 role.addToPolicy(new PolicyStatement({actions:['s3:ListBucket','s3:ListBucketVersions','s3:GetBucketVersioning'],resources:[backend.storage.resources.bucket.bucketArn,'arn:aws:s3:::'+pilot.FixturePhotoBucket]}));
}
const app=backend.auth.resources.userPool.node.root as App;
// BELLO currently uses HTTP reads/writes, not GraphQL subscriptions. Exclude only
// those unused resolvers from this regression copy so initial creation stays
// below CloudFormation's 2,500-resource operation limit. All 63 real models,
// field authorization, read/write resolvers and relationship queries remain.
const nodes=app.node.findAll(),resolvers=nodes.filter((n):n is CfnResolver=>n instanceof CfnResolver);
const functionRefs=(r:CfnResolver)=>JSON.stringify(Stack.of(r).resolve(r.pipelineConfig??{}));
const subscriptions=resolvers.filter(r=>r.typeName==='Subscription');
for(const f of nodes.filter((n):n is CfnFunctionConfiguration=>n instanceof CfnFunctionConfiguration)){
 const id=Stack.of(f).getLogicalId(f),sameStack=(r:CfnResolver)=>Stack.of(r)===Stack.of(f)&&functionRefs(r).includes('"'+id+'"');
 if(subscriptions.some(sameStack)&&!resolvers.some(r=>r.typeName!=='Subscription'&&sameStack(r)))f.node.scope!.node.tryRemoveChild(f.node.id);
}
for(const r of subscriptions)r.node.scope!.node.tryRemoveChild(r.node.id);
app.synth();
