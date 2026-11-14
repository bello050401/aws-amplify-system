import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { COMPLETION_REPORT_SCHEMA, buildExecutionContract } from './reportSchema.mjs';
import { validate } from '../core/validate.mjs';
import { redactText } from '../log/redact.mjs';
import { runProcess, localEnvironment, writeEvidence } from '../pipeline/process.mjs';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT, reasoningEffortArg, restrictedCodexArgs } from './codexOptions.mjs';
import { classifyFailureText, REVIEW_FAILURE } from '../review/errors.mjs';

export function resolveCodexExecutable(configured = 'codex', { env = process.env, platform = process.platform, lookup = spawnSync } = {}) {
  const requested = configured || 'codex';
  // An explicit path is authoritative; never silently replace a broken custom installation.
  if (path.isAbsolute(requested) || /[\\/]/.test(requested)) return fs.existsSync(requested) ? requested : null;
  const found = lookup(platform === 'win32' ? 'where.exe' : 'which', [requested], { encoding:'utf8', windowsHide:true, env });
  const candidates = found.status === 0 ? String(found.stdout || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean) : [];
  const native = candidates.find(file=>fs.existsSync(file) && (platform !== 'win32' || /\.exe$/i.test(file)));
  if (native) return native;
  if (platform === 'win32' && /^codex(?:\.exe)?$/i.test(requested) && env.LOCALAPPDATA) {
    const root=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    try {
      const bundled=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(root,e.name,'codex.exe')).filter(file=>fs.existsSync(file));
      bundled.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs || a.localeCompare(b));
      if(bundled.length) return bundled[0];
    } catch {}
  }
  return null;
}

export async function probeCodexLogin({ executable = 'codex', resolveExecutable = resolveCodexExecutable, execute = runProcess } = {}) {
  const file = resolveExecutable(executable);
  if (!file) return { ok: false, reason: 'Codex executable not found' };
  const result = await execute({ file, args: ['login', 'status'], env: localEnvironment(), timeoutMs: 15000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.ok && /^Logged in using ChatGPT\s*$/im.test(output)) return { ok: true, reason: null };
  return { ok: false, reason: redactText(output || result.error || result.reason || 'ChatGPT subscription authentication required').slice(-2000) };
}

export function parseCodexEvents(result) {
  const events = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* Keep preceding complete events. */ }
  }
  const lastTurn = events.findLast(event => ['turn.completed', 'turn.failed'].includes(event?.type));
  const usage = lastTurn?.usage ?? events.findLast(event => event?.type === 'turn.completed')?.usage;
  const totalTokens = [usage?.input_tokens, usage?.output_tokens].every(n => Number.isFinite(n) && n >= 0)
    ? usage.input_tokens + usage.output_tokens
    : null;
  const completed = result.ok && lastTurn?.type === 'turn.completed';
  const errorEvent = events.findLast(event => event?.type === 'error');
  const detail = lastTurn?.error?.message || errorEvent?.message || errorEvent?.error?.message
    || result.stderr || result.stdout || result.error || result.reason || 'No completed Codex turn';
  const providerError = completed ? null : redactText(String(detail)).slice(-2000);
  const errorCode = lastTurn?.error?.code || lastTurn?.error?.status || errorEvent?.code || errorEvent?.error?.code || errorEvent?.status;
  const classified = classifyFailureText([errorCode, providerError, result.stderr].filter(Boolean).join('\n'));
  const providerStatus = completed ? null
    : classified === REVIEW_FAILURE.USAGE_LIMIT ? 'capacity'
    : classified === REVIEW_FAILURE.AUTH_EXPIRED ? 'auth'
    : /network|stream disconnect|connection (?:closed|failed|reset|refused)|cannot connect|failed to connect|service unavailable|gateway|\b(?:500|502|503|504)\b/i.test(String(providerError)) ? 'blocked'
    : null;
  return {
    completed, usage: totalTokens === null ? null : usage, totalTokens, providerError, providerStatus,
    sessionId: events.find(event => event?.type === 'thread.started')?.thread_id ?? null,
    unexpectedToolUse: events.some(event => event?.item && !['agent_message', 'reasoning'].includes(event.item.type)),
  };
}

// Structured Outputs requires every property to be listed in required.
// Optional report fields become nullable for transport and are omitted again after decoding.
export function codexReportSchema(schema = COMPLETION_REPORT_SCHEMA) {
  const result = structuredClone(schema);
  if (result.type === 'object') {
    const required = new Set(result.required || []);
    for (const [key, value] of Object.entries(result.properties || {})) {
      const child = codexReportSchema(value);
      result.properties[key] = required.has(key) ? child : { anyOf: [child, { type: 'null' }] };
    }
    result.required = Object.keys(result.properties || {});
    result.additionalProperties = false;
  } else if (result.type === 'array') result.items = codexReportSchema(result.items);
  return result;
}
function omitNulls(value) {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== null).map(([k,v]) => [k,omitNulls(v)]));
  return value;
}
export class CodexRunner {
  constructor({ config, paths, logger, execute = runProcess, resolveExecutable = resolveCodexExecutable }) { this.config = config; this.paths = paths; this.logger = logger; this.execute = execute; this.resolveExecutable = resolveExecutable; }
  buildArgs({ workDir, schemaPath, reportPath }) {
    const model = this.config.codex?.model || DEFAULT_CODEX_MODEL;
    const effort = reasoningEffortArg(this.config.codex?.reasoningEffort, model);
    return ['exec', ...restrictedCodexArgs('workspace-write'), '--model', model, '-c', effort,
      '--cd', workDir, '--output-schema', schemaPath, '--output-last-message', reportPath, '-'];
  }
  async run({ task, instruction, shouldStop = () => false, onHeartbeat = () => {} }) {
    const base = { ok: false, report: null, reportErrors: [], sessionId: null, costUsd: null, terminationReason: 'spawn_failed' };
    if (task.isolation !== 'worktree' || !task.work_dir) return { ...base, error: 'Codex実装は専用worktreeが必要です。' };
    const executable = this.resolveExecutable(this.config.codex?.executable || 'codex');
    if (!executable) return { ...base, error: 'Codex実行ファイルが見つかりません。設定・PATH・デスクトップ同梱先を確認しました。' };
    const login = await probeCodexLogin({ executable, resolveExecutable: () => executable, execute: this.execute });
    if (!login.ok) return { ...base, providerStatus: 'auth', providerError: login.reason, error: login.reason };
    const directory = path.join(this.paths.runsDir, task.id, `codex-${crypto.randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    const schemaPath = path.join(directory, 'schema.json');
    const reportPath = path.join(directory, 'report.json');
    fs.writeFileSync(schemaPath, JSON.stringify(codexReportSchema()));
    const input = buildExecutionContract({ taskId: task.id, repoPath: task.repo_path, branch: task.branch, workDir: task.work_dir, isolation: task.isolation, baseCommit: task.base_commit }) + instruction;
    const started = Date.now();
    const result = await this.execute({ file: executable, args: this.buildArgs({ workDir: task.work_dir, schemaPath, reportPath }), cwd: task.work_dir, env: localEnvironment(), input, timeoutMs: (this.config.codex?.timeoutSeconds || 3600) * 1000, shouldStop, onOutput: onHeartbeat });
    const stdoutPath = writeEvidence(directory, 'events.json', result);
    const events = parseCodexEvents(result);
    const outcome = { ...base, ...events, promptBytes: Buffer.byteLength(input), exitCode: result.exitCode, durationMs: Date.now() - started, stdoutPath, stderrTail: redactText(result.stderr || '').slice(-2000), terminationReason: events.completed ? 'completed' : result.reason || (result.exitCode === null && result.error ? 'spawn_failed' : 'crashed'), error: events.providerError || result.error };
    if (!events.completed) return outcome;
    try {
      if (fs.statSync(reportPath).size > 1024 * 1024) throw new Error('完了報告が大きすぎます');
      const report = omitNulls(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
      fs.writeFileSync(reportPath, redactText(JSON.stringify(report, null, 2)));
      const check = validate(report, COMPLETION_REPORT_SCHEMA);
      if (report.taskId !== task.id) check.errors.push('taskIdが実行対象と一致しません');
      return { ...outcome, ok: check.errors.length === 0, report, reportErrors: check.errors };
    } catch (err) { return { ...outcome, error: err.message }; }
  }
}

export class ImplementationRouter {
  constructor({ repo, config, runners }) { this.repo = repo; this.config = config; this.runners = runners; }
  async run(args) {
    const provider = this.repo.store.getMeta('implementationProvider') || this.config.execution?.provider || 'codex';
    if (!this.runners[provider]) throw new Error('未対応の実装担当です: ' + provider);
    this.repo.checkpoint(args.task.id, 'implementation_provider', provider === 'codex'
      ? { provider, model: this.config.codex?.model || DEFAULT_CODEX_MODEL,
          reasoningEffort: this.config.codex?.reasoningEffort ?? DEFAULT_CODEX_EFFORT, reason: 'Host implementation settings' }
      : { provider });
    return this.runners[provider].run(args);
  }
}
