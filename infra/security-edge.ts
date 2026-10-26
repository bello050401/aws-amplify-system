/** Separate us-east-1 Amplify WAF. Exact host scope; no automatic association. */
import {App,Stack} from 'aws-cdk-lib';
import {addSecurityEdge} from './securityEdgeResources';
const app=new App(),account=process.env.CDK_DEFAULT_ACCOUNT;
if(!account||!process.env.SECURITY_AMPLIFY_APP_ARN||!process.env.SECURITY_EDGE_HOST)throw Error('Account, exact app ARN and host required');
const stack=new Stack(app,'BelloSecurityEdge',{env:{account,region:'us-east-1'}});
addSecurityEdge(stack,{appArn:process.env.SECURITY_AMPLIFY_APP_ARN,host:process.env.SECURITY_EDGE_HOST,
 mode:(process.env.SECURITY_EDGE_MODE??'count') as 'count'|'block',associate:process.env.SECURITY_EDGE_ASSOCIATE==='yes',logging:process.env.SECURITY_EDGE_LOGGING==='yes'});
app.synth();
