import { App, Stack, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolClient, CfnUserPoolGroup, UserPool } from "aws-cdk-lib/aws-cognito";
import { Table, AttributeType, BillingMode, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { PolicyStatement, CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnApi, CfnIntegration, CfnRoute, CfnStage, CfnAuthorizer } from "aws-cdk-lib/aws-apigatewayv2";
import {Bucket,BlockPublicAccess,BucketEncryption} from 'aws-cdk-lib/aws-s3';
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { join } from "node:path";
import {GraphqlApi,AuthorizationType,SchemaFile,MappingTemplate} from 'aws-cdk-lib/aws-appsync';
import {CfnWebACL,CfnWebACLAssociation} from 'aws-cdk-lib/aws-wafv2';

/** A NEW, isolated test pool/table/API. Never imports existing production resources. */
const app = new App();
const stack = new Stack(app, "BelloSecurityPilot20261026", { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-west-2" } });
const api = new CfnApi(stack, "Api", { name: "BELLO security pilot (no business data)", protocolType: "HTTP", disableExecuteApiEndpoint: false });
const host = api.ref + ".execute-api." + stack.region + ".amazonaws.com";
const origin = "https://" + host;
const pool = new CfnUserPool(stack, "Pool", { userPoolName: "bello-security-pilot-20261026", userPoolTier: "ESSENTIALS",
  adminCreateUserConfig: { allowAdminCreateUserOnly: true },
  usernameAttributes: ["email"], autoVerifiedAttributes: [],
  usernameConfiguration: { caseSensitive: false }, deletionProtection: "ACTIVE",
  policies: { passwordPolicy: { minimumLength: 14, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true, temporaryPasswordValidityDays: 3 },
    signInPolicy: { allowedFirstAuthFactors: ["PASSWORD", "WEB_AUTHN"] } },
  webAuthnRelyingPartyId: host, webAuthnUserVerification: "required", webAuthnFactorConfiguration: "MULTI_FACTOR_WITH_USER_VERIFICATION",
  mfaConfiguration: "OPTIONAL", enabledMfas: ["SOFTWARE_TOKEN_MFA"],
  accountRecoverySetting: { recoveryMechanisms: [{ name: "admin_only", priority: 1 }] },
});
pool.applyRemovalPolicy(RemovalPolicy.RETAIN);
const client = new CfnUserPoolClient(stack, "Client", { userPoolId: pool.ref, clientName: "server-only-broker",
  generateSecret: true, explicitAuthFlows: ["ALLOW_USER_AUTH", "ALLOW_USER_PASSWORD_AUTH"],
  preventUserExistenceErrors: "ENABLED", enableTokenRevocation: true,
  accessTokenValidity: 5, idTokenValidity: 5, refreshTokenValidity: 30,
  tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "days" },
  refreshTokenRotation: { feature: "ENABLED", retryGracePeriodSeconds: 10 }, authSessionValidity: 3,
});
for (const [i, name] of ["Admins", "ADMIN", "EDITOR", "VIEWER", "PHOTO_DEVICE"].entries())
  new CfnUserPoolGroup(stack, "Group" + i, { userPoolId: pool.ref, groupName: name, precedence: i });
const table = new Table(stack, "SecurityState", { partitionKey: { name: "id", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED, timeToLiveAttribute: "expiresAt", deletionProtection: true,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: RemovalPolicy.RETAIN });
table.addGlobalSecondaryIndex({ indexName: "ByKind", partitionKey: { name: "kind", type: AttributeType.STRING }, sortKey: { name: "id", type: AttributeType.STRING } });
const businessTables=Object.fromEntries(["Inventory","InventoryHistory","InventoryCategory","Category"].map(name=>[name,new Table(stack,"Fixture"+name,{
  partitionKey:{name:"id",type:AttributeType.STRING},billingMode:BillingMode.PAY_PER_REQUEST,encryption:TableEncryption.AWS_MANAGED,
  pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},deletionProtection:true,removalPolicy:RemovalPolicy.RETAIN,
})]));
const key = new Key(stack, "SessionEncryption", { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN, description: "BELLO pilot encrypted server-side auth tokens" });
const secret = new Secret(stack, "ClientSecret", { description: "Pilot Cognito confidential app client; server only",
  generateSecretString: { secretStringTemplate: JSON.stringify({ pendingSetup: true }), generateStringKey: "placeholder", passwordLength: 32 },
  removalPolicy: RemovalPolicy.RETAIN });
const logs = new LogGroup(stack, "AuditLogs", { retention: RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
const dataGate = new Secret(stack,'DataGate',{description:'Server-only AppSync origin gate; never sent to browsers',generateSecretString:{secretStringTemplate:'{}',generateStringKey:'value',passwordLength:48,excludePunctuation:true},removalPolicy:RemovalPolicy.RETAIN});
const dataApi = new GraphqlApi(stack,'ProtectedData',{name:'bello-security-isolated-inventory',schema:SchemaFile.fromAsset(join(__dirname,'security-pilot.graphql')),authorizationConfig:{defaultAuthorization:{authorizationType:AuthorizationType.USER_POOL,userPoolConfig:{userPool:UserPool.fromUserPoolId(stack,'DataIdentity',pool.ref),appIdClientRegex:client.ref}},additionalAuthorizationModes:[{authorizationType:AuthorizationType.API_KEY}]}});
dataApi.addDynamoDbDataSource('Inventory',businessTables.Inventory).createResolver('ReadInventory',{typeName:'Query',fieldName:'getInventory',requestMappingTemplate:MappingTemplate.fromString('#if(!$ctx.identity.claims.get("cognito:groups").contains("ADMIN") && !$ctx.identity.claims.get("cognito:groups").contains("EDITOR") && !$ctx.identity.claims.get("cognito:groups").contains("VIEWER"))\n$util.unauthorized()\n#end\n{"version":"2018-05-29","operation":"GetItem","key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},"consistentRead":true}'),responseMappingTemplate:MappingTemplate.dynamoDbResultItem()});
const dataAcl=new CfnWebACL(stack,'DataBoundary',{scope:'REGIONAL',defaultAction:{block:{}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloDataBoundary',sampledRequestsEnabled:false},rules:[{name:'OnlyServerOrigin',priority:0,action:{allow:{}},statement:{byteMatchStatement:{fieldToMatch:{singleHeader:{Name:'x-bello-data-gate'}},positionalConstraint:'EXACTLY',searchString:dataGate.secretValueFromJson('value').unsafeUnwrap(),textTransformations:[{priority:0,type:'NONE'}]}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'BelloTrustedDataOrigin',sampledRequestsEnabled:false}}]});
new CfnWebACLAssociation(stack,'DataBoundaryAssociation',{resourceArn:dataApi.arn,webAclArn:dataAcl.attrArn});
const fn = new Function(stack, "Gateway", { runtime: Runtime.NODEJS_22_X, handler: "handler.handler",
  code: Code.fromAsset(join(__dirname, "../tools/bello-security-pilot/dist")), memorySize: 512, timeout: Duration.seconds(25),
  logGroup: logs, environment: { SECURITY_TABLE: table.tableName, SECURITY_KEY_ARN: key.keyArn,
    SECURITY_DEPLOYMENT: stack.stackName, SECURITY_ORIGIN: origin,
    SECURITY_POOL_ID: pool.ref, SECURITY_CLIENT_ID: client.ref, SECURITY_CLIENT_SECRET_ARN: secret.secretArn,
    SECURITY_APPSYNC_GATE_SECRET_ARN:dataGate.secretArn,PILOT_GRAPHQL_URL:dataApi.graphqlUrl,
    ...Object.fromEntries(Object.entries(businessTables).map(([name,resource])=>["PILOT_"+name.toUpperCase()+"_TABLE",resource.tableName])) } });
(fn.role!.node.defaultChild as CfnRole).managedPolicyArns = [];
logs.grantWrite(fn);
fn.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
  resources: [table.tableArn, table.tableArn + "/index/ByKind"] }));
key.grant(fn, "kms:GenerateDataKey", "kms:Decrypt");secret.grantRead(fn);
fn.addToRolePolicy(new PolicyStatement({actions:['cognito-idp:AdminCreateUser','cognito-idp:AdminAddUserToGroup','cognito-idp:AdminDisableUser'],resources:[pool.attrArn]}));
dataGate.grantRead(fn);
for(const resource of Object.values(businessTables))fn.addToRolePolicy(new PolicyStatement({actions:["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],resources:[resource.tableArn]}));
const integration = new CfnIntegration(stack, "Integration", { apiId: api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0" });
new CfnRoute(stack, "Route", { apiId: api.ref, routeKey: "$default", target: "integrations/" + integration.ref });
new CfnStage(stack, "Stage", { apiId: api.ref, stageName: "$default", autoDeploy: true, defaultRouteSettings: { throttlingBurstLimit: 20, throttlingRateLimit: 5 } });
fn.addPermission("ApiGateway", { principal: new ServicePrincipal("apigateway.amazonaws.com"), sourceArn: "arn:aws:execute-api:" + stack.region + ":" + stack.account + ":" + api.ref + "/*/*" });
// The actual PhotoStation HTTP handler, with new isolated data/S3 and no external
// services. JWT + the machine's non-exportable key + approval are all required.
const photoTable=new Table(stack,'FixturePhotos',{partitionKey:{name:'PK',type:AttributeType.STRING},sortKey:{name:'SK',type:AttributeType.STRING},billingMode:BillingMode.PAY_PER_REQUEST,encryption:TableEncryption.AWS_MANAGED,pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},removalPolicy:RemovalPolicy.RETAIN,deletionProtection:true});
for(const n of [1,2])photoTable.addGlobalSecondaryIndex({indexName:'GSI'+n,partitionKey:{name:'GSI'+n+'PK',type:AttributeType.STRING},sortKey:{name:'GSI'+n+'SK',type:AttributeType.STRING}});
const photoBucket=new Bucket(stack,'FixturePhotoStorage',{encryption:BucketEncryption.S3_MANAGED,blockPublicAccess:BlockPublicAccess.BLOCK_ALL,enforceSSL:true,versioned:true,removalPolicy:RemovalPolicy.RETAIN,lifecycleRules:[{id:'TestDataRetention',expiration:Duration.days(14),noncurrentVersionExpiration:Duration.days(1),abortIncompleteMultipartUploadAfter:Duration.days(1)}]});
const photoLogs=new LogGroup(stack,'PhotoLogs',{retention:RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN});
const photoFn=new Function(stack,'PhotoGateway',{runtime:Runtime.NODEJS_22_X,handler:'photo.handler',code:Code.fromAsset(join(__dirname,'../tools/bello-security-pilot/photo-dist')),memorySize:512,timeout:Duration.seconds(25),logGroup:photoLogs,environment:{PHOTO_REGISTRATION_TABLE_NAME:photoTable.tableName,INVENTORY_TABLE_NAME:businessTables.Inventory.tableName,PHOTO_REGISTRATION_BUCKET_NAME:photoBucket.bucketName,PHOTO_DEVICE_GROUP_DEPLOYED:'true',BELLO_PHOTO_DEVICE_APPROVAL:'enforced',SECURITY_TABLE:table.tableName,PHOTO_SECURITY_ORIGIN:origin}});
(photoFn.role!.node.defaultChild as CfnRole).managedPolicyArns=[];photoLogs.grantWrite(photoFn);
photoTable.grantReadWriteData(photoFn);businessTables.Inventory.grantReadData(photoFn);
photoFn.addToRolePolicy(new PolicyStatement({actions:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem'],resources:[table.tableArn]}));
photoBucket.grantReadWrite(photoFn,'photo-batches/*');
const photoAuth=new CfnAuthorizer(stack,'PhotoJwt',{apiId:api.ref,name:'VerifiedPhotoStationJwt',authorizerType:'JWT',identitySource:['$request.header.Authorization'],jwtConfiguration:{audience:[client.ref],issuer:'https://cognito-idp.'+stack.region+'.amazonaws.com/'+pool.ref}});
const photoIntegration=new CfnIntegration(stack,'PhotoIntegration',{apiId:api.ref,integrationType:'AWS_PROXY',integrationUri:photoFn.functionArn,payloadFormatVersion:'2.0'});
new CfnRoute(stack,'PhotoRoute',{apiId:api.ref,routeKey:'POST /photo/{operation}',target:'integrations/'+photoIntegration.ref,authorizationType:'JWT',authorizerId:photoAuth.ref});
photoFn.addPermission('PhotoApiGateway',{principal:new ServicePrincipal('apigateway.amazonaws.com'),sourceArn:'arn:aws:execute-api:'+stack.region+':'+stack.account+':'+api.ref+'/*/POST/photo/*'});
new CfnOutput(stack,'FixturePhotoBucket',{value:photoBucket.bucketName});new CfnOutput(stack,'FixturePhotoTable',{value:photoTable.tableName});
new Alarm(stack, "GatewayErrors", { metric: fn.metricErrors({ period: Duration.minutes(5) }), threshold: 5, evaluationPeriods: 1, comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: TreatMissingData.NOT_BREACHING });
for (const [name, value] of Object.entries({ Origin: origin, PoolId: pool.ref, ClientId: client.ref, Table: table.tableName, KeyArn: key.keyArn, SecretArn: secret.secretArn, FunctionName: fn.functionName }))
  new CfnOutput(stack, name, { value });
for(const [name,resource] of Object.entries(businessTables))new CfnOutput(stack,"Fixture"+name+"Table",{value:resource.tableName});
new CfnOutput(stack,'ProtectedGraphqlUrl',{value:dataApi.graphqlUrl});
new CfnOutput(stack,'DataGateSecretArn',{value:dataGate.secretArn});
new CfnOutput(stack,'ProtectedGraphqlId',{value:dataApi.apiId});
app.synth();
