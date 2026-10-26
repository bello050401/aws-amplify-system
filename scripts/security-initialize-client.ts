/** Explicit operator preparation. Never prints or writes secrets to local disk. */
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {CognitoIdentityProviderClient,DescribeUserPoolClientCommand} from '@aws-sdk/client-cognito-identity-provider';
import {SecretsManagerClient,GetSecretValueCommand,PutSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
async function main(){
 const args=Object.fromEntries(process.argv.slice(2).map(s=>s.split('=',2))),account=args['--account'];
 const c=JSON.parse(fs.readFileSync(args['--outputs']||'amplify_outputs.json','utf8')).custom?.deviceSecurity;
 if(!c||!['prepare','enforced'].includes(c.phase)||!/^\d{12}$/.test(account??''))throw Error('Prepared outputs and exact --account are required');
 const caller=await new STSClient({region:c.region}).send(new GetCallerIdentityCommand({}));
 if(caller.Account!==account||!c.clientSecretArn.startsWith('arn:aws:secretsmanager:'+c.region+':'+account+':'))throw Error('AWS account mismatch');
 const secrets=new SecretsManagerClient({region:c.region}),pool=new CognitoIdentityProviderClient({region:c.region});
 const previous=JSON.parse((await secrets.send(new GetSecretValueCommand({SecretId:c.clientSecretArn}))).SecretString??'{}');
 const client=(await pool.send(new DescribeUserPoolClientCommand({UserPoolId:c.poolId,ClientId:c.clientId}))).UserPoolClient;
 if(!client?.ClientSecret||!client.ExplicitAuthFlows?.includes('ALLOW_USER_AUTH'))throw Error('Confidential passkey client required');
 if(previous.clientSecret){
  if(previous.clientSecret!==client.ClientSecret||typeof previous.contextKey!=='string'||previous.contextKey.length<43)throw Error('Existing credential mismatch: do not overwrite; inspect recovery plan');
  console.log('Already initialized; existing session signing key preserved.');return;
 }
 if(previous.pendingSetup!==true)throw Error('Refusing to overwrite an unrecognized secret');
 if(!('--apply' in args)){console.log('Preparation validated. No mutation. Add --apply to initialize this prepared client.');return;}
 await secrets.send(new PutSecretValueCommand({SecretId:c.clientSecretArn,SecretString:JSON.stringify({clientSecret:client.ClientSecret,contextKey:randomBytes(48).toString('base64url'),clientId:c.clientId})}));
 console.log('Client initialized in Secrets Manager; no credential output.');
}
main().catch(()=>{console.error('SECURITY_CLIENT_PREPARATION_FAILED; no credential details are logged.');process.exitCode=1});
