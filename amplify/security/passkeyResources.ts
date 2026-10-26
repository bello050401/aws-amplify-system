import {Duration,Stack,CustomResource} from 'aws-cdk-lib';
import {CfnUserPool} from 'aws-cdk-lib/aws-cognito';
import {PolicyStatement} from 'aws-cdk-lib/aws-iam';
import {LogGroup,RetentionDays} from 'aws-cdk-lib/aws-logs';
import {Runtime} from 'aws-cdk-lib/aws-lambda';
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import {Provider} from 'aws-cdk-lib/custom-resources';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

/** CloudFormation's RP field is limited to 63, but the official Cognito API
 * accepts 127. Keep the exact origin: never broaden to a shared parent domain. */
export function configurePasskeys(pool:CfnUserPool,hostname:string){
 if(hostname.length>127||!hostname.split('.').every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)))throw Error('Invalid Cognito relying-party hostname (maximum 127 characters)');
 if(hostname.length<=63){
  pool.webAuthnRelyingPartyId=hostname;pool.webAuthnUserVerification='required';pool.webAuthnFactorConfiguration='MULTI_FACTOR_WITH_USER_VERIFICATION';return;
 }
 const stack=Stack.of(pool);
 // Reapply after any managed pool definition change, including rollback.
 // Delete intentionally does nothing: removing a deployment helper must not
 // erase credentials or silently weaken the remaining pool's authentication.
 const fingerprint=createHash('sha256').update(JSON.stringify(stack.resolve(pool._toCloudFormation()))).digest('hex').slice(0,24);
 const handler=new NodejsFunction(stack,'ExactPasskeyConfigurationHandler',{
  entry:resolve('amplify/security/passkeyConfigurationHandler.ts'),handler:'handler',runtime:Runtime.NODEJS_22_X,timeout:Duration.minutes(1),
  bundling:{bundleAwsSDK:true,minify:true},
  logGroup:new LogGroup(stack,'PasskeyConfigurationLogs',{retention:RetentionDays.ONE_MONTH}),
 });
 handler.addToRolePolicy(new PolicyStatement({actions:['cognito-idp:GetUserPoolMfaConfig','cognito-idp:SetUserPoolMfaConfig'],resources:[pool.attrArn]}));
 const provider=new Provider(stack,'ExactPasskeyConfigurationProvider',{onEventHandler:handler,
  logGroup:new LogGroup(stack,'PasskeyProviderLogs',{retention:RetentionDays.ONE_MONTH}),
 });
 const resource=new CustomResource(stack,'ExactPasskeyRelyingParty',{serviceToken:provider.serviceToken,resourceType:'Custom::BelloExactPasskeyRp',properties:{PoolId:pool.ref,Hostname:hostname,PoolDefinition:fingerprint,HandlerVersion:handler.currentVersion.version}});
 resource.node.addDependency(pool);
 return resource;
}
