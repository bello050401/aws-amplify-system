import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {resolveCodexExecutable,CodexRunner,probeCodexLogin} from '../src/runner/codexRunner.mjs';
import { DEFAULT_ECO, routeModel, validateEco } from '../src/eco/policy.mjs';
import { validateRouting } from '../src/eco/taskRouting.mjs';
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

test('Codex implementation dispatch preserves model, effort and usage when the turn fails', async t => {
 const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bello-codex-run-'));
 t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));
 const calls = [];
 const runner = new CodexRunner({
   config: { codex: { model: 'gpt-6.1-terra', reasoningEffort: 'low' } },
   paths: { runsDir },
   resolveExecutable: () => 'codex',
   execute: async request => {
     calls.push(request);
     if (request.args[0] === 'login') return { ok: true, stderr: 'Logged in using ChatGPT' };
     return { ok: false, stderr: 'wrapper error', reason: 'exit_nonzero', stdout: [
       { type: 'thread.started', thread_id: 'thread-fixture' },
       { type: 'turn.failed', error: { message: 'ChatGPT usage limit reached' }, usage: { input_tokens: 40, cached_input_tokens: 35, output_tokens: 5 } },
     ].map(JSON.stringify).join('\n') };
   },
 });
 const result = await runner.run({ task: { id: 'fixture', isolation: 'worktree', work_dir: runsDir }, instruction: 'Return a report.' });
 assert.deepEqual(calls.map(request => request.args[0]), ['login', 'exec']);
 const { args, env, input } = calls[1];
 assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-terra');
 assert.ok(args.includes('model_reasoning_effort="low"'));
 assert.ok(args.includes('forced_login_method="chatgpt"'));
 assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
 assert.equal(env.OPENAI_API_KEY, undefined);
 assert.equal(result.providerStatus, 'capacity');
 assert.equal(result.providerError, 'ChatGPT usage limit reached');
 assert.equal(result.totalTokens, 45);
 assert.equal(result.sessionId, 'thread-fixture');
 assert.equal(result.promptBytes, Buffer.byteLength(input));
});

test('Codex subscription probe rejects API-key and unverified login output', async () => {
 for (const stdout of ['Logged in using an API key', 'Logged in']) {
   const result = await probeCodexLogin({ resolveExecutable: () => 'codex', execute: async () => ({ ok: true, stdout }) });
   assert.equal(result.ok, false);
   assert.equal(result.reason, stdout);
 }
});

test('Codex reasoning defaults are proportional and invalid model combinations are rejected', () => {
 for (const [phase, model, effort] of [
   ['local_ui', 'gpt-6.1-terra', 'low'],
   ['implementation', 'gpt-6.1-sol', 'medium'],
   ['architecture', 'gpt-6.1-sol', 'high'],
 ]) {
   const selection = routeModel(DEFAULT_ECO, { phase });
   assert.equal(selection.model, model);
   assert.equal(selection.reasoningEffort, effort);
 }
 const l = { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'ultra', capabilities: ['code'] };
 assert.throws(() => validateRouting({ catalog: [{ ...l, tier: 'standard', evaluations: {} }] }), /catalog/);
 assert.throws(() => validateEco({ modelPolicy: { standard: l } }), /Invalid model mapping/);
 assert.equal(routeModel(DEFAULT_ECO, { phase: 'implementation', capacityLimited: true }).waiting, 'WAITING_CAPACITY');
});
