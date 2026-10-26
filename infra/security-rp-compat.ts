/** Disposable compatibility test. Does not import any production pool. */
import {App,Stack,CfnOutput,RemovalPolicy} from 'aws-cdk-lib';
import {CfnUserPool,CfnUserPoolClient} from 'aws-cdk-lib/aws-cognito';
import {configurePasskeys} from '../amplify/security/passkeyResources';
if(process.env.AWS_REGION!=='us-west-2'||process.env.CDK_DEFAULT_REGION!=='us-west-2'||process.env.CDK_DEFAULT_ACCOUNT!=='203918843421')throw Error('Isolated RP test region required');
const app=new App(),stack=new Stack(app,'BelloSecurityRpCompatibility20261026',{env:{account:'203918843421',region:'us-west-2'}});
const pool=new CfnUserPool(stack,'CompatibilityPool',{userPoolName:'bello-security-disposable-rp-20261026',userPoolTier:'ESSENTIALS',
 adminCreateUserConfig:{allowAdminCreateUserOnly:true},mfaConfiguration:'OPTIONAL',enabledMfas:['SOFTWARE_TOKEN_MFA'],
 policies:{signInPolicy:{allowedFirstAuthFactors:['PASSWORD','WEB_AUTHN']}}});
pool.applyRemovalPolicy(RemovalPolicy.DESTROY);
const hostname='cognito-production-length-compatibility-20261026.bello.example.com';
const compatibility=configurePasskeys(pool,hostname);
if(!compatibility)throw Error('Test hostname must exceed CloudFormation limit');
const client=new CfnUserPoolClient(stack,'CompatibilityClient',{userPoolId:pool.ref,explicitAuthFlows:['ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_AUTH'],generateSecret:false});
client.node.addDependency(compatibility);
new CfnOutput(stack,'PoolId',{value:pool.ref});new CfnOutput(stack,'ClientId',{value:client.ref});new CfnOutput(stack,'ExactRp',{value:hostname});
app.synth();
