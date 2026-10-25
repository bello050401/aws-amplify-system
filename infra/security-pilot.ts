import { App, Stack, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolClient, CfnUserPoolGroup } from "aws-cdk-lib/aws-cognito";
import { Table, AttributeType, BillingMode, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { PolicyStatement, CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnApi, CfnIntegration, CfnRoute, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { join } from "node:path";

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
for (const [i, name] of ["Admins", "ADMIN", "EDITOR", "VIEWER"].entries())
  new CfnUserPoolGroup(stack, "Group" + i, { userPoolId: pool.ref, groupName: name, precedence: i });
const table = new Table(stack, "SecurityState", { partitionKey: { name: "id", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED, timeToLiveAttribute: "expiresAt", deletionProtection: true,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: RemovalPolicy.RETAIN });
table.addGlobalSecondaryIndex({ indexName: "ByKind", partitionKey: { name: "kind", type: AttributeType.STRING }, sortKey: { name: "id", type: AttributeType.STRING } });
const key = new Key(stack, "SessionEncryption", { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN, description: "BELLO pilot encrypted server-side auth tokens" });
const secret = new Secret(stack, "ClientSecret", { description: "Pilot Cognito confidential app client; server only",
  generateSecretString: { secretStringTemplate: JSON.stringify({ pendingSetup: true }), generateStringKey: "placeholder", passwordLength: 32 },
  removalPolicy: RemovalPolicy.RETAIN });
const logs = new LogGroup(stack, "AuditLogs", { retention: RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
const fn = new Function(stack, "Gateway", { runtime: Runtime.NODEJS_22_X, handler: "handler.handler",
  code: Code.fromAsset(join(__dirname, "../tools/bello-security-pilot/dist")), memorySize: 512, timeout: Duration.seconds(25),
  logGroup: logs, environment: { SECURITY_TABLE: table.tableName, SECURITY_KEY_ARN: key.keyArn,
    SECURITY_DEPLOYMENT: stack.stackName, SECURITY_ORIGIN: origin,
    SECURITY_POOL_ID: pool.ref, SECURITY_CLIENT_ID: client.ref, SECURITY_CLIENT_SECRET_ARN: secret.secretArn } });
(fn.role!.node.defaultChild as CfnRole).managedPolicyArns = [];
logs.grantWrite(fn);
fn.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
  resources: [table.tableArn, table.tableArn + "/index/ByKind"] }));
key.grant(fn, "kms:GenerateDataKey", "kms:Decrypt");secret.grantRead(fn);
const integration = new CfnIntegration(stack, "Integration", { apiId: api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0" });
new CfnRoute(stack, "Route", { apiId: api.ref, routeKey: "$default", target: "integrations/" + integration.ref });
new CfnStage(stack, "Stage", { apiId: api.ref, stageName: "$default", autoDeploy: true, defaultRouteSettings: { throttlingBurstLimit: 20, throttlingRateLimit: 5 } });
fn.addPermission("ApiGateway", { principal: new ServicePrincipal("apigateway.amazonaws.com"), sourceArn: "arn:aws:execute-api:" + stack.region + ":" + stack.account + ":" + api.ref + "/*/*" });
new Alarm(stack, "GatewayErrors", { metric: fn.metricErrors({ period: Duration.minutes(5) }), threshold: 5, evaluationPeriods: 1, comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: TreatMissingData.NOT_BREACHING });
for (const [name, value] of Object.entries({ Origin: origin, PoolId: pool.ref, ClientId: client.ref, Table: table.tableName, KeyArn: key.keyArn, SecretArn: secret.secretArn, FunctionName: fn.functionName }))
  new CfnOutput(stack, name, { value });
app.synth();
