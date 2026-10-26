import {CognitoIdentityProviderClient,GetUserPoolMfaConfigCommand,SetUserPoolMfaConfigCommand} from '@aws-sdk/client-cognito-identity-provider';
type Event={RequestType:string;PhysicalResourceId?:string;ResourceProperties:{PoolId:string;Hostname:string}};
/** Cognito resets omitted MFA settings. Preserve all existing factors before
 * setting the exact RP. No credentials or individual user data are involved. */
export async function configure(event:Event,client:{send:(command:any)=>Promise<any>}){
 const {PoolId,Hostname}=event.ResourceProperties;
 const PhysicalResourceId=event.PhysicalResourceId??'bello-exact-rp-'+PoolId;
 if(event.RequestType==='Delete')return{PhysicalResourceId};
 if(!['Create','Update'].includes(event.RequestType)||!/^us-west-2_[A-Za-z0-9]+$/.test(PoolId)||Hostname.length>127||!Hostname.split('.').every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)))throw Error('Invalid passkey configuration');
 const before=await client.send(new GetUserPoolMfaConfigCommand({UserPoolId:PoolId}));
 if(!['OFF','OPTIONAL','ON'].includes(before.MfaConfiguration))throw Error('Existing MFA configuration is unknown');
 await client.send(new SetUserPoolMfaConfigCommand({UserPoolId:PoolId,MfaConfiguration:before.MfaConfiguration,
  ...(before.SmsMfaConfiguration?{SmsMfaConfiguration:before.SmsMfaConfiguration}:{}),
  ...(before.SoftwareTokenMfaConfiguration?{SoftwareTokenMfaConfiguration:before.SoftwareTokenMfaConfiguration}:{}),
  ...(before.EmailMfaConfiguration?{EmailMfaConfiguration:before.EmailMfaConfiguration}:{}),
  WebAuthnConfiguration:{RelyingPartyId:Hostname,UserVerification:'required',FactorConfiguration:'MULTI_FACTOR_WITH_USER_VERIFICATION'},
 }));
 return{PhysicalResourceId};
}
export const handler=(event:Event)=>configure(event,new CognitoIdentityProviderClient({region:'us-west-2',maxAttempts:3}));
