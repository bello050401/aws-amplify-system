import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Evaluate the real config with POSIX paths and a normal (non-junction) install.
// This catches shared folders hidden locally by a broad Windows dependency target.
test('clean Linux Metro sees new shared imports while retaining existing resolver defaults',()=>{
 const mobile='/codebuild/output/src/project/mobile';
 type ResolveContext={originModulePath:string;resolveRequest:(context:{originModulePath:string},name:string,platform:string)=>string};
 const moduleResult={exports:{} as {watchFolders:string[];resolver:{nodeModulesPaths:string[];sourceExts:string[];resolveRequest:(context:ResolveContext,name:string,platform:string)=>string};transformer:{asyncRequireModulePath:string;sentinel:boolean}}};
 const defaultSourceExts=['ts','tsx','js'];
 vm.runInNewContext(readFileSync(new URL('../metro.config.js',import.meta.url),'utf8'),{
  __dirname:mobile,module:moduleResult,
  require:(name:string)=>{
   if(name==='expo/metro-config')return {getDefaultConfig:()=>({watchFolders:[],resolver:{sourceExts:defaultSourceExts},transformer:{asyncRequireModulePath:'default-loader',sentinel:true}})};
   if(name==='node:path')return path.posix;
   if(name==='node:fs')return {realpathSync:(value:string)=>value};
   throw Error('Unexpected config dependency '+name);
  },
 });
 const config=moduleResult.exports;
 const visible=(relative:string)=>config.watchFolders.some(folder=>{const file=path.posix.resolve(mobile,relative);return file===folder||file.startsWith(folder+'/');});
 for(const file of ['../lib/systemErrors/client.ts','../lib/systemErrors/contract.ts','../lib/systemErrors/native.ts','../lib/procurement/providers.ts'])assert.equal(visible(file),true,file+' must be visible without a junction');
 assert.equal(config.watchFolders.includes('/codebuild/output/src/project'),false,'do not broaden watch scope to whole repository');
 assert.deepEqual(Array.from(config.resolver.nodeModulesPaths),[mobile+'/node_modules']);
 assert.equal(config.resolver.sourceExts,defaultSourceExts);
 assert.equal(config.transformer.asyncRequireModulePath,'default-loader');assert.equal(config.transformer.sentinel,true);
 const calls:Array<{originModulePath:string;name:string;platform:string}>=[];
 const context={originModulePath:'/codebuild/output/src/project/components/example.tsx',resolveRequest:(received:{originModulePath:string},name:string,platform:string)=>{calls.push({originModulePath:received.originModulePath,name,platform});return 'resolved';}};
 config.resolver.resolveRequest(context,'react/jsx-runtime','web');config.resolver.resolveRequest(context,'./local','web');
 assert.equal(calls[0].originModulePath,mobile+'/index.ts');assert.equal(calls[1].originModulePath,context.originModulePath);
});
