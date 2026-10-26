const cp=require('node:child_process');
function commands(env){
 if(env.AWS_BRANCH==='codex/security-20261026'){
  if(env.AWS_APP_ID!=='d4hkkg7dty2du')throw Error('Wrong isolated hosting app');
  return [[process.execPath,['scripts/security-hosted-build.cjs']]];
 }
 if(!env.AWS_BRANCH||!env.AWS_APP_ID)throw Error('Explicit Amplify branch and app are required');
 return [[process.execPath,['scripts/check-security-release.cjs']],[process.platform==='win32'?'npx.cmd':'npx',['ampx','pipeline-deploy','--branch',env.AWS_BRANCH,'--app-id',env.AWS_APP_ID]]];
}
module.exports={commands};
if(require.main===module){for(const [command,args] of commands(process.env))cp.execFileSync(command,args,{stdio:'inherit'})}
