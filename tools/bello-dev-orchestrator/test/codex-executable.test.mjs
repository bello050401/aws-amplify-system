import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {resolveCodexExecutable,CodexRunner} from '../src/runner/codexRunner.mjs';
test('scheduled task without PATH Codex finds desktop bundled executable',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bello-codex-exe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const exe=path.join(root,'OpenAI','Codex','bin','fixture-version','codex.exe');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'fixture');
 const options={platform:'win32',env:{LOCALAPPDATA:root},lookup:()=>({status:1})};
 assert.equal(resolveCodexExecutable('codex',options),exe);
 assert.equal(resolveCodexExecutable(path.join(root,'missing.exe'),options),null);
 assert.equal(resolveCodexExecutable('custom-codex',options),null);
 assert.equal(resolveCodexExecutable(exe,options),exe);
});
test('missing executable fails before dispatch with spawn_failed',async()=>{
 let calls=0;const runner=new CodexRunner({config:{},paths:{},resolveExecutable:()=>null,execute:async()=>{calls++;}});
 const result=await runner.run({task:{isolation:'worktree',work_dir:'fixture'},instruction:'x'});
 assert.equal(result.terminationReason,'spawn_failed');assert.equal(calls,0);
});
