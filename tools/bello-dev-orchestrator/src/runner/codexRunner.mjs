import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPLETION_REPORT_SCHEMA, buildExecutionContract } from './reportSchema.mjs';
import { validate } from '../core/validate.mjs';
import { redactText } from '../log/redact.mjs';
import { runProcess, localEnvironment, writeEvidence } from '../pipeline/process.mjs';

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
  constructor({ config, paths, logger, execute = runProcess }) { this.config = config; this.paths = paths; this.logger = logger; this.execute = execute; }
  buildArgs({ workDir, schemaPath, reportPath }) {
    const args = ['exec', '--ignore-user-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false', '--ephemeral', '--json', '--color', 'never', '--cd', workDir, '--output-schema', schemaPath, '--output-last-message', reportPath];
    if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"');
    if (this.config.codex?.model) args.push('--model', this.config.codex.model);
    return [...args, '-'];
  }
  async run({ task, instruction, shouldStop = () => false, onHeartbeat = () => {} }) {
    const base = { ok: false, report: null, reportErrors: [], sessionId: null, costUsd: null, terminationReason: 'spawn_failed' };
    if (task.isolation !== 'worktree' || !task.work_dir) return { ...base, error: 'Codex実装は専用worktreeが必要です。' };
    const directory = path.join(this.paths.runsDir, task.id, `codex-${crypto.randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    const schemaPath = path.join(directory, 'schema.json');
    const reportPath = path.join(directory, 'report.json');
    fs.writeFileSync(schemaPath, JSON.stringify(codexReportSchema()));
    const input = buildExecutionContract({ taskId: task.id, repoPath: task.repo_path, branch: task.branch, workDir: task.work_dir, isolation: task.isolation, baseCommit: task.base_commit }) + instruction;
    const started = Date.now();
    const result = await this.execute({ file: this.config.codex?.executable || 'codex', args: this.buildArgs({ workDir: task.work_dir, schemaPath, reportPath }), cwd: task.work_dir, env: localEnvironment(), input, timeoutMs: (this.config.codex?.timeoutSeconds || 3600) * 1000, shouldStop, onOutput: onHeartbeat });
    const stdoutPath = writeEvidence(directory, 'events.json', result);
    const outcome = { ...base, exitCode: result.exitCode, durationMs: Date.now() - started, stdoutPath, stderrTail: result.stderr?.slice(-2000), terminationReason: result.ok ? 'completed' : result.reason || 'crashed', error: result.error };
    if (!result.ok) return outcome;
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
    const provider = this.repo.store.getMeta('implementationProvider') || this.config.execution?.provider || 'claude';
    if (!this.runners[provider]) throw new Error('未対応の実装担当です: ' + provider);
    this.repo.checkpoint(args.task.id, 'implementation_provider', { provider });
    return this.runners[provider].run(args);
  }
}
