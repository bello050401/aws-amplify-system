/** Write only a strict allowlist of NON-SECRET server settings. Never NEXT_PUBLIC. */
const fs=require('node:fs');
function settings(env,outputs){
 const enabled=env.BELLO_DEVICE_SECURITY==='enforced';
 if(!enabled)return {BELLO_DEVICE_SECURITY:'legacy'};
 const c=outputs.custom?.deviceSecurity;
 if(!c||c.phase!=='enforced'||c.origin!==env.SECURITY_ORIGIN)throw Error('Security resources/runtime do not match');
 const result={BELLO_DEVICE_SECURITY:'enforced',SECURITY_REGION:c.region,SECURITY_TABLE:c.table,
  SECURITY_KEY_ARN:c.keyArn,SECURITY_DEPLOYMENT:c.deployment,SECURITY_POOL_ID:c.poolId,
  SECURITY_CLIENT_ID:c.clientId,SECURITY_CLIENT_SECRET_ARN:c.clientSecretArn,SECURITY_ORIGIN:c.origin,
  SECURITY_APPSYNC_GATE_SECRET_ARN:c.dataGateSecretArn};
 if(Object.values(result).some(x=>typeof x!=='string'||!x||/[\r\n]/.test(x)))throw Error('Invalid security setting');
 // Source IP trust is not enabled by an arbitrary env/header. Hosting verification
 // evidence is checked separately before this exact option may be set.
 if(env.SECURITY_TRUSTED_SOURCE==='cloudfront-viewer-address')result.SECURITY_TRUSTED_SOURCE=env.SECURITY_TRUSTED_SOURCE;
 return result;
}
module.exports={settings};
if(require.main===module){
 const values=settings(process.env,JSON.parse(fs.readFileSync('amplify_outputs.json','utf8')));
 fs.appendFileSync('.env.production','\n'+Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n');
 console.log('Security server configuration prepared; no secrets exported.');
}
