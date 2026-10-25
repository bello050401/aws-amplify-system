const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const out={};let payload=null,forged=false,verified=0,tokenPresent=true;
const stubs={
 'server-only':{},'next/headers':{cookies:()=>{}},
 'aws-amplify/auth/server':{fetchAuthSession:async()=>({tokens:tokenPresent?{accessToken:{toString:()=> 'test-token',payload:{'cognito:groups':['ADMIN']}}}:undefined})},
 'aws-jwt-verify':{CognitoJwtVerifier:{create:config=>{assert.equal(config.tokenUse,'access');assert.ok(config.userPoolId&&config.clientId);return{verify:async()=>{verified++;if(forged)throw Error('invalid signature');return payload;}};}}},
 '../amplify/userPoolServer':{runWithUserPoolServerContext:async({operation})=>operation({})},
 '../amplify/requestCache':{requestCache:fn=>fn},
 '../../amplify_outputs.json':{default:{auth:{user_pool_id:'pool',user_pool_client_id:'client'}}},
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/inventory/mutationSession.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:out,require:n=>{if(!(n in stubs))throw Error(n);return stubs[n];}});
(async()=>{
 for(const role of ['ADMIN','EDITOR','VIEWER']){
  payload={sub:'owner','cognito:groups':[role]};
  assert.equal((await out.inventoryVerifiedReadSession()).role,role);
  assert.equal(Boolean(await out.inventoryMutationSession()),role!=='VIEWER');
 }
 payload={sub:'owner','cognito:groups':['unrelated']};assert.equal(await out.inventoryVerifiedReadSession(),null);
 forged=true;payload={sub:'owner','cognito:groups':['ADMIN']};assert.equal(await out.inventoryVerifiedReadSession(),null);assert.equal(await out.inventoryMutationSession(),null);
 tokenPresent=false;const before=verified;assert.equal(await out.inventoryVerifiedReadSession(),null);assert.equal(verified,before);
 console.log('Verified session checks passed: signature required, all read roles, mutation role restriction, missing token denied.');
})().catch(e=>{console.error(e);process.exitCode=1;});
