import {RemovalPolicy,Stack} from 'aws-cdk-lib';
import {CfnUserPool,CfnUserPoolClient,IUserPool} from 'aws-cdk-lib/aws-cognito';
import {AttributeType,BillingMode,Table,TableEncryption} from 'aws-cdk-lib/aws-dynamodb';
import {Key} from 'aws-cdk-lib/aws-kms';
import {Secret,type ISecret} from 'aws-cdk-lib/aws-secretsmanager';
import {AnyPrincipal,ArnPrincipal,Effect,IRole,ManagedPolicy,PolicyStatement,Role} from 'aws-cdk-lib/aws-iam';
import {IBucket} from 'aws-cdk-lib/aws-s3';
import {CfnGraphQLApi} from 'aws-cdk-lib/aws-appsync';
import {CfnWebACL,CfnWebACLAssociation} from 'aws-cdk-lib/aws-wafv2';

export type DeviceResourceOptions={
 stack:Stack; pool:IUserPool; cfnPool:CfnUserPool; api:CfnGraphQLApi; bucket:IBucket;
 runtime:IRole; identityRoles:IRole[]; origin:string; phase:'prepare'|'enforced'; recoveryOperatorArn?:string;
 existingDataGate?:ISecret;
};
/** Additive preparation preserves the existing pool, users, groups and browser
 * client. Enforcement is a separate, reviewed release: never enabled by default. */
export function addDeviceResources(o:DeviceResourceOptions){
 const {stack}=o,parsed=new URL(o.origin);
 if(parsed.protocol!=='https:'||parsed.origin!==o.origin)throw Error('Exact HTTPS security origin required');
 // CloudFormation/Cognito limits WebAuthnRelyingPartyID to 63 characters.
 if(parsed.hostname.length>63)throw Error('Cognito passkey hostname must be at most 63 characters');
 const pool=o.cfnPool;
 const oldPolicies=pool.policies as CfnUserPool.PoliciesProperty|undefined;
 pool.userPoolTier='ESSENTIALS';
 pool.policies={...oldPolicies,signInPolicy:{allowedFirstAuthFactors:['PASSWORD','WEB_AUTHN']}};
 pool.webAuthnRelyingPartyId=parsed.hostname;
 pool.webAuthnUserVerification='required';
 pool.webAuthnFactorConfiguration='MULTI_FACTOR_WITH_USER_VERIFICATION';
 // Existing MFA/password/recovery configuration is deliberately preserved.
 const client=new CfnUserPoolClient(stack,'DeviceSessionClient',{
  userPoolId:o.pool.userPoolId,clientName:'BELLO server-only device sessions',generateSecret:true,
  explicitAuthFlows:['ALLOW_USER_AUTH','ALLOW_USER_PASSWORD_AUTH'],preventUserExistenceErrors:'ENABLED',
  enableTokenRevocation:true,accessTokenValidity:5,idTokenValidity:5,refreshTokenValidity:30,
  tokenValidityUnits:{accessToken:'minutes',idToken:'minutes',refreshToken:'days'},
  refreshTokenRotation:{feature:'ENABLED',retryGracePeriodSeconds:10},authSessionValidity:3,
 });
 client.applyRemovalPolicy(RemovalPolicy.RETAIN);
 const table=new Table(stack,'DeviceSecurityState',{
  partitionKey:{name:'id',type:AttributeType.STRING},billingMode:BillingMode.PAY_PER_REQUEST,
  encryption:TableEncryption.AWS_MANAGED,timeToLiveAttribute:'expiresAt',deletionProtection:true,
  pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},removalPolicy:RemovalPolicy.RETAIN,
 });
 table.addGlobalSecondaryIndex({indexName:'ByKind',partitionKey:{name:'kind',type:AttributeType.STRING},sortKey:{name:'id',type:AttributeType.STRING}});
 const key=new Key(stack,'DeviceSessionKey',{enableKeyRotation:true,removalPolicy:RemovalPolicy.RETAIN});
 const secret=new Secret(stack,'DeviceClientCredentials',{generateSecretString:{secretStringTemplate:JSON.stringify({pendingSetup:true}),generateStringKey:'placeholder',passwordLength:32},removalPolicy:RemovalPolicy.RETAIN});
 const gate=o.existingDataGate??new Secret(stack,'DeviceDataGate',{generateSecretString:{secretStringTemplate:'{}',generateStringKey:'value',passwordLength:48,excludePunctuation:true},removalPolicy:RemovalPolicy.RETAIN});
 new ManagedPolicy(stack,'DeviceRuntimeAccess',{roles:[o.runtime],statements:[
  new PolicyStatement({actions:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query'],resources:[table.tableArn,table.tableArn+'/index/ByKind']}),
  new PolicyStatement({actions:['kms:GenerateDataKey','kms:Decrypt'],resources:[key.keyArn]}),
  new PolicyStatement({actions:['secretsmanager:GetSecretValue'],resources:[secret.secretArn,gate.secretArn]}),
  new PolicyStatement({actions:['cognito-idp:AdminCreateUser','cognito-idp:AdminAddUserToGroup','cognito-idp:AdminDisableUser'],resources:[o.pool.userPoolArn]}),
 ]});
 let recoveryRole:Role|undefined;
 if(o.recoveryOperatorArn){
  if(!/^arn:aws:iam::\d{12}:(user|role)\/.+/.test(o.recoveryOperatorArn))throw Error('Exact recovery operator ARN required');
  recoveryRole=new Role(stack,'DeviceRecoveryOperator',{assumedBy:new ArnPrincipal(o.recoveryOperatorArn).withConditions({Bool:{'aws:MultiFactorAuthPresent':'true'},NumericLessThanEquals:{'aws:MultiFactorAuthAge':300}}),
   description:'Emergency approval of one verified pending administrator device. MFA required.'});
  recoveryRole.addToPolicy(new PolicyStatement({actions:['dynamodb:GetItem'],resources:[table.tableArn],
   conditions:{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':['user#*','device#*']}}}));
  recoveryRole.addToPolicy(new PolicyStatement({actions:['dynamodb:PutItem'],resources:[table.tableArn],
   conditions:{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':['device#*','event#*']}}}));
 }
 if(o.phase==='enforced'){
  // Default API_KEY remains for the public CMS models. Every request must
  // traverse the server; existing per-model authorization still applies.
  o.api.additionalAuthenticationProviders=[
   {authenticationType:'AMAZON_COGNITO_USER_POOLS',userPoolConfig:{userPoolId:o.pool.userPoolId,awsRegion:stack.region,appIdClientRegex:client.ref}},
   {authenticationType:'AWS_IAM'},
  ];
  const dataStack=Stack.of(o.api);
  const acl=new CfnWebACL(dataStack,'DeviceDataBoundary',{scope:'REGIONAL',defaultAction:{block:{}},
   visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloDeviceDataBoundary',sampledRequestsEnabled:false},
   rules:[{name:'ServerOriginOnly',priority:0,action:{allow:{}},statement:{byteMatchStatement:{
    fieldToMatch:{singleHeader:{Name:'x-bello-data-gate'}},positionalConstraint:'EXACTLY',
    searchString:gate.secretValueFromJson('value').unsafeUnwrap(),textTransformations:[{priority:0,type:'NONE'}]}},
    visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloDeviceDataAllowed',sampledRequestsEnabled:false}}]});
  new CfnWebACLAssociation(dataStack,'DeviceDataBoundaryAssociation',{resourceArn:o.api.attrArn,webAclArn:acl.attrArn});
  o.bucket.addToResourcePolicy(new PolicyStatement({effect:Effect.DENY,principals:[new AnyPrincipal()],
   actions:['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:DeleteObject','s3:DeleteObjectVersion'],
   resources:[o.bucket.arnForObjects('*')],conditions:{ArnEquals:{'aws:PrincipalArn':o.identityRoles.map(r=>r.roleArn)}}}));
 }
 return{table,key,secret,client,gate,recoveryRole,configuration:{
  phase:o.phase,origin:o.origin,region:stack.region,deployment:stack.stackName,poolId:o.pool.userPoolId,
  clientId:client.ref,table:table.tableName,keyArn:key.keyArn,clientSecretArn:secret.secretArn,dataGateSecretArn:gate.secretArn,
  ...(recoveryRole?{recoveryRoleArn:recoveryRole.roleArn}:{}),
 }};
}
