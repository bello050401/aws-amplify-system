/** Real AWS configuration compatibility; never a physical passkey assertion. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {CognitoIdentityProviderClient,DescribeUserPoolCommand,GetUserPoolMfaConfigCommand,AdminCreateUserCommand,AdminSetUserPasswordCommand,AdminDisableUserCommand,InitiateAuthCommand,StartWebAuthnRegistrationCommand} from '@aws-sdk/client-cognito-identity-provider';
const output=JSON.parse(fs.readFileSync('artifacts/security-20261026/rp-outputs.json','utf8')).BelloSecurityRpCompatibility20261026;
const client=new CognitoIdentityProviderClient({region:'us-west-2'}),results:string[]=[];
async function main(){
 const pool=(await client.send(new DescribeUserPoolCommand({UserPoolId:output.PoolId}))).UserPool!;
 assert.equal(pool.Name,'bello-security-disposable-rp-20261026');
 assert.equal(output.ExactRp,'cognito-production-length-compatibility-20261026.bello.example.com');assert(output.ExactRp.length>63);
 const config=await client.send(new GetUserPoolMfaConfigCommand({UserPoolId:output.PoolId}));
 assert.equal(config.WebAuthnConfiguration?.RelyingPartyId,output.ExactRp);assert.equal(config.WebAuthnConfiguration?.UserVerification,'required');
 assert.equal(config.WebAuthnConfiguration?.FactorConfiguration,'MULTI_FACTOR_WITH_USER_VERIFICATION');results.push('Exact long RP and required user verification retained');
 assert.equal(config.MfaConfiguration,'OPTIONAL');assert.equal(config.SoftwareTokenMfaConfiguration?.Enabled,true);results.push('Existing optional TOTP MFA unchanged');
 const username='qa-rp-'+Date.now(),password='Aa1!'+randomBytes(24).toString('base64url');let created=false;
 try{
  await client.send(new AdminCreateUserCommand({UserPoolId:output.PoolId,Username:username,MessageAction:'SUPPRESS'}));created=true;
  await client.send(new AdminSetUserPasswordCommand({UserPoolId:output.PoolId,Username:username,Password:password,Permanent:true}));
  const auth=await client.send(new InitiateAuthCommand({ClientId:output.ClientId,AuthFlow:'USER_PASSWORD_AUTH',AuthParameters:{USERNAME:username,PASSWORD:password}}));
  assert(auth.AuthenticationResult?.AccessToken);results.push('Existing password login still works after RP configuration');
  const registration=await client.send(new StartWebAuthnRegistrationCommand({AccessToken:auth.AuthenticationResult.AccessToken}));
  const options=typeof registration.CredentialCreationOptions==='string'?JSON.parse(registration.CredentialCreationOptions):registration.CredentialCreationOptions;
  assert.equal(options?.rp.id,output.ExactRp);assert.equal(options?.authenticatorSelection.userVerification,'required');results.push('Real Cognito enrollment options contain the exact long hostname');
 }finally{if(created)await client.send(new AdminDisableUserCommand({UserPoolId:output.PoolId,Username:username}));}
 fs.writeFileSync('artifacts/security-20261026/rp-live-results.json',JSON.stringify({at:new Date().toISOString(),passed:results.length,results,productionChanged:false,hardwarePasskey:'NOT_TESTED',testAccountDisabled:true},null,2));
 console.log(JSON.stringify({passed:results.length,failed:0,productionChanged:false}));
}main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});
