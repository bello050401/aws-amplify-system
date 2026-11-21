import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {saleFixtureHost,projectSaleMemoryHandler} from './sale-fixture-host.mjs';
import {fingerprint} from '../src/pipeline/verification.mjs';
import {CUA_CSP_SHA256} from '../src/pipeline/cuaBoundary.mjs';
import {FROZEN_HTTP_MODE,FROZEN_HTTP_ACTIONS,FIXTURE_OPERATIONS,SALE_FIXTURE_SCHEMA_SHA256,SALE_FIXTURE_PATHS_SHA256} from '../src/pipeline/frozenHttpFixture.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
/** The actual generated connection profile, also checked by runtime-contract regression tests. */
export function saleHttpRuntimeProfile({repo,allowedPaths,verification,qaUrl,desktopCua,staging}){
 return {targetApp:'inventory_web',repoPath:repo,allowedPaths,implementationProvider:'codex',models:{codex:{model:'gpt-6.1-sol',reasoningEffort:'medium'}},verification,qaUrl,allowedDomains:['127.0.0.1'],desktopCua,staging,qaSteps:{sequence:[{type:'navigate'},{type:'reload'},{type:'screenshot'}],maxTotalSeconds:120}};
}
/** Trusted host assembly only. Input names exact reviewed files and already-built assets. */
export function prepareSaleHttpFixture(input){
 const root=path.resolve(input.output),repo=fs.realpathSync(input.repoPath),head=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true});
 if(head.status!==0||head.stdout.trim()!==input.sourceHead||!(/^[a-f0-9]{40}$/).test(input.sourceHead))throw Error('Exact final combined source HEAD required');
 const status=spawnSync('git',['status','--porcelain','--untracked-files=all'],{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});if(status.status!==0||status.stdout.trim())throw Error('Clean dedicated final-HEAD source checkout required; keep artifacts outside it');
 if(fs.existsSync(root)||!Number.isInteger(input.port)||input.port<1024||input.port>65535||input.port===43143)throw Error('New dedicated fixture directory and port required');
 const read=(name)=>{const filename=path.join(repo,name),result=spawnSync('git',['show',input.sourceHead+':'+name],{cwd:repo,encoding:null,windowsHide:true,maxBuffer:16*1024*1024});if(result.status!==0||!result.stdout.equals(fs.readFileSync(filename)))throw Error('Reviewed source differs from HEAD: '+name);return result.stdout;};
 const serve=read('scripts/qa/sale-desktop-ui/serve.cjs'),main=read('scripts/qa/sale-desktop-ui/main.tsx'),component=read('components/sales/DesktopSaleJobs.tsx'),host=saleFixtureHost(fs.readFileSync(input.originalHostPath,'utf8')),runtime=projectSaleMemoryHandler(serve.toString());
 const old=JSON.parse(fs.readFileSync(input.approvedProfilePath)),base=old.profiles.inventory_web.staging,prior=JSON.parse(fs.readFileSync(base.hostBundle.descriptorPath));
 const bundle=path.join(root,'bundle'),hostDir=path.join(root,'host'),dataRoot=path.join(root,'runtime'),directory=path.join(root,'bridge');for(const d of [bundle,hostDir,dataRoot,directory])fs.mkdirSync(d,{recursive:true});
 const manifest={},put=(name,bytes)=>{const p=path.join(bundle,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);manifest[name]=sha(bytes);};
 put('mxc-host.cjs',host);put('app/runtime.cjs',runtime);put('app/package.json','{"private":true}');put('provenance/serve-source.cjs',serve);put('provenance/main.tsx',main);put('provenance/DesktopSaleJobs.tsx',component);
 const assets={};for(const [url,name] of Object.entries({'/':'index.html','/ui.js':'ui.js','/style.css':'style.css','/fixture.svg':'fixture.svg'})){const bytes=fs.readFileSync(path.join(input.assetDirectory,name));put('app/'+name,bytes);assets[url]=sha(bytes);}
 // This independent command verifies the frozen UI/handler contract, not backend/Next integration.
 const expected={...manifest};put('checks/fixture.cjs',`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');const root=path.resolve(__dirname,'..');for(const [file,hash]of Object.entries(${JSON.stringify(expected)}))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),hash,file);const handler=require('../app/runtime.cjs');assert.equal(typeof handler,'function');console.log('Frozen synthetic UI assets and projected memory handler verified; backend and Next excluded');`);
 const verification={required:true,commands:[{name:'frozen-sale-ui-contract',file:'node',args:['checks/fixture.cjs'],timeoutSeconds:60}]};
 const source={commit:input.sourceHead,fingerprint:fingerprint(repo),plan:sha(JSON.stringify(verification))};
 const descriptor={source,appDir:'app',node:prior.node,codex:prior.codex,manifest,verification:[{entry:'checks/fixture.cjs',args:['checks/fixture.cjs'],timeoutMs:60000}]};const descriptorPath=path.join(bundle,'bundle.json');fs.writeFileSync(descriptorPath,JSON.stringify(descriptor));fs.writeFileSync(path.join(hostDir,'mxc-host.cjs'),host);
 const fixtureContract={kind:'sale-desktop-memory-v1',syntheticMemoryOnly:true,sourceHead:source.commit,runtimeEntry:'runtime.cjs',runtimeSha256:sha(runtime),serveSourceSha256:sha(serve),componentSha256:sha(component),mainSha256:sha(main),projection:'frozen-assets-unchanged-memory-handler',assets};
 const qaUrl='http://127.0.0.1:'+input.port+'/',desktopCua={driver:'desktop-cua',frozenReviewedFixture:true,bundleSha256:sha(fs.readFileSync(descriptorPath)),cspSha256:CUA_CSP_SHA256,servedPathsSha256:SALE_FIXTURE_PATHS_SHA256,postSchemaSha256:SALE_FIXTURE_SCHEMA_SHA256,allowedActions:[...FROZEN_HTTP_ACTIONS],requiredFixtureOperations:[...FIXTURE_OPERATIONS],directory,sessionPath:path.join(directory,'session.json')};
 const staging={...base,mode:FROZEN_HTTP_MODE,framework:'frozen-http-fixture',port:input.port,qaUrl,dataRoot,hostAdapterPath:path.join(hostDir,'mxc-host.cjs'),hostAdapterSha256:sha(host),hostBundle:{descriptorPath,sha256:desktopCua.bundleSha256},environmentId:'sale-desktop-frozen-http',dataScopeId:'sale-desktop-synthetic-memory',dataAdapter:{kind:'fixture',id:'sale-desktop-synthetic-memory'},desktopCua,fixtureContract};delete staging.hostApproval;
 staging.hostApproval={...staging,approved:true,approvalId:input.taskId+'-reviewed-frozen-http'};
 const profile=saleHttpRuntimeProfile({repo,allowedPaths:input.allowedPaths,verification,qaUrl,desktopCua,staging});
 const profileFile=path.join(root,'eco-runtime-cua.json');fs.writeFileSync(profileFile,JSON.stringify({schemaVersion:1,profiles:{inventory_web:profile}},null,2));
 const receipt={profileFile,source,fixtureContract,hostAdapterPath:staging.hostAdapterPath,hostAdapterSha256:staging.hostAdapterSha256,bundleSha256:desktopCua.bundleSha256,projection:{originalServeExecuted:false,excluded:['esbuild startup','postcss startup','original listen(43143)'],included:'unchanged synthetic globals and HTTP handler; exact frozen assets'},coverage:'Production desktop UI with synthetic memory handler only; not Next or backend integration'};fs.writeFileSync(path.join(root,'assembly.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(prepareSaleHttpFixture(JSON.parse(fs.readFileSync(process.argv[2]))),null,2));
