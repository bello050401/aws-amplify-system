/** HTTPS regression branch only. Reuse an isolated backend; never pipeline-deploy. */
const fs=require('node:fs'),cp=require('node:child_process');
const {settings}=require('./security-runtime-environment.cjs');
const APP='d4hkkg7dty2du',BRANCH='codex/security-20261026';
const ORIGIN='https://codex-security-20261026.d4hkkg7dty2du.amplifyapp.com';
const STACK='amplify-bellosecuritybusiness-20261026-sandbox-40e26f1744';
function prepare(env,outputs){
 if(env.AWS_APP_ID!==APP||env.AWS_BRANCH!==BRANCH)throw Error('Isolated security branch only');
 const c=outputs.custom?.deviceSecurity;
 if(c?.poolId!=='us-west-2_iCUa4QWvi'||c.origin!==ORIGIN||c.phase!=='enforced'||
   outputs.data?.url!=='https://5cufjlyzvbdlxd74q3j5rqwquy.appsync-api.us-west-2.amazonaws.com/graphql'||
   outputs.storage?.bucket_name!=='amplify-bellosecuritybusi-belloinventorystoragebuc-alf7jbmof57c')throw Error('Isolated backend mismatch');
 return {...settings({BELLO_DEVICE_SECURITY:'enforced',SECURITY_ORIGIN:ORIGIN},outputs),
  AWS_REGION:'us-west-2',BELLO_MOBILE_WRITES_ENABLED:'true',BELLO_MOBILE_PUBLIC_ORIGIN:ORIGIN,
  SECURITY_EDGE_LOG_GROUP:'aws-waf-logs-bello-security-stage',SECURITY_EDGE_LOG_REGION:'us-east-1',
  CONVERSATION_TABLE_NAME:'Conversation-yau3id5kzjepfbr6b7wt42nstq-NONE',MESSAGE_TABLE_NAME:'Message-yau3id5kzjepfbr6b7wt42nstq-NONE',
  PHOTO_REGISTRATION_AWS_REGION:'us-west-2',PHOTO_REGISTRATION_BUCKET_NAME:'bellosecuritypilot2026102-fixturephotostorage478ba-iixvfe7t3nzv',
  PHOTO_REGISTRATION_TABLE_NAME:'BelloSecurityPilot20261026-FixturePhotosA8EAA0D3-15T87HTXNB3M',
  PHOTO_REGISTRATION_INVENTORY_TABLE_NAME:'Inventory-yau3id5kzjepfbr6b7wt42nstq-NONE',
  AGENTCORE_GATEWAY_URL:'',MERCARI_RELAY_URL:'',MESSAGING_ATTACHMENT_BUCKET:outputs.storage.bucket_name,
  BASE_PRIVATE_TEST_WRITES_ENABLED:'0',BASE_MANUAL_LISTING_ENABLED:'0',BELLO_SHOP_CONNECTION_ENABLED:'0',MERCARI_PRIVATE_CREATE_TRIAL_ENABLED:'0',
  PHOTO_CACHE_TELEMETRY_ENABLED:'0',INVENTORY_SPEED_PROBE_ENABLED:'0'};
}
module.exports={prepare};
if(require.main===module){
 if(process.env.AWS_APP_ID!==APP||process.env.AWS_BRANCH!==BRANCH)throw Error('Isolated security branch only');
 for(const name of ['app/security-stage-fixture','public/security-stage-fixture.html','public/security-stage-fixture.js']){
  if(fs.existsSync(name))throw Error('Loopback test fixtures must NEVER be deployed');
 }
 cp.execFileSync(process.platform==='win32'?'npx.cmd':'npx',['ampx','generate','outputs','--stack',STACK,'--out-dir','.'],{
  stdio:'inherit',env:{...process.env,AWS_REGION:'us-west-2',AWS_DEFAULT_REGION:'us-west-2'}});
 const values=prepare(process.env,JSON.parse(fs.readFileSync('amplify_outputs.json','utf8')));
 fs.writeFileSync('.env.production',Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n');
 console.log('Isolated HTTPS security backend selected. No production deployment or secret export.');
}
