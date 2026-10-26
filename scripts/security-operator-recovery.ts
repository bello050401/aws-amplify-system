/** Run only through a separately controlled, MFA-protected AWS operator role. */
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {DynamoSecurityStore} from '../lib/security/awsStore';
import {approveRecoveryDevice} from '../lib/security/operatorRecovery';
import {keyId} from '../lib/security/crypto';
import type {Device} from '../lib/security/types';
async function main(){
 const args=Object.fromEntries(process.argv.slice(2).map(v=>{const n=v.indexOf('=');return n<0?[v,'true']:[v.slice(0,n),v.slice(n+1)]}));
 const table=process.env.SECURITY_TABLE,region=process.env.SECURITY_REGION;
 if(!table||!region||!args['--device']||!args['--account'])throw Error('Set SECURITY_TABLE, SECURITY_REGION and --device=... --account=...');
 const caller=await new STSClient({region}).send(new GetCallerIdentityCommand({}));
 if(caller.Account!==args['--account']||!caller.Arn?.includes(':assumed-role/'))throw Error('Use the verified MFA operator role for this account');
 const store=new DynamoSecurityStore(table,region),device=await store.get<Device>(args['--device']);
 if(!device)throw Error('Device not found');
 if(args['--apply']!=='true'){console.log(JSON.stringify({table,operator:caller.Arn,deviceId:device.id,sub:device.sub,status:device.status,version:device.version,fingerprint:keyId(device.publicKey),apply:false}));return;}
 const result=await approveRecoveryDevice(store,{sub:args['--sub'],deviceId:device.id,version:Number(args['--version']),fingerprint:args['--fingerprint'],verificationCode:args['--verification-code'],personConfirmed:args['--person-confirmed']==='true'},caller.Arn);
 console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.name==='SecurityError'?e.code:'Recovery failed; no success is assumed.');process.exitCode=1});
