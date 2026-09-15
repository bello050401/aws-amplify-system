import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runGit } from '../core/git.mjs';
import { runProcess, writeEvidence } from './process.mjs';

export function fingerprint(directory) {
  const listed = runGit(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (!listed.ok) throw new Error('検証対象のファイル一覧を取得できません');
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(listed.stdoutRaw.split('\0').filter(Boolean))].sort()) {
    const full = path.resolve(directory, file);
    hash.update(file + '\0');
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) hash.update('link:' + fs.readlinkSync(full));
      else if (stat.isFile()) hash.update(fs.readFileSync(full));
      else hash.update('non-file');
    } catch (err) { if (err.code === 'ENOENT') hash.update('deleted'); else throw err; }
    hash.update('\0');
  }
  return hash.digest('hex');
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class IndependentVerifier {
  constructor({ config, paths, repo, execute = runProcess }) {
    this.settings = structuredClone(config.verification ?? { required: false, commands: [] });
    this.paths = paths; this.repo = repo; this.execute = execute;
  }
  get required() { return this.settings.required; }
  async run(task, shouldStop = () => false) {
    try { return await this.executeTask(task, shouldStop); }
    catch (err) {
      const receipt = { attempt: task.attempts, fingerprint: null, plan: digest(this.settings), passed: false, results: [], error: err.message };
      this.repo.checkpoint(task.id, 'independent_verification', receipt);
      return receipt;
    }
  }
  async executeTask(task, shouldStop = () => false) {
    const cwd = task.work_dir || task.repo_path;
    const before = fingerprint(cwd);
    const results = [];
    for (const command of this.settings.commands) {
      const target = path.resolve(cwd, command.cwd || '.');
      const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(target));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('検証コマンドの作業場所がworktree外です');
      const result = await this.execute({ file: command.file, args: command.args, cwd: target, timeoutMs: (command.timeoutSeconds || 600) * 1000, shouldStop });
      const evidencePath = writeEvidence(path.join(this.paths.runsDir, task.id, 'verification'), `${task.attempts}-${crypto.randomUUID()}.json`, { command, ...result });
      results.push({ name: command.name, exitCode: result.exitCode, passed: result.ok, reason: result.reason || result.error, evidencePath });
      if (!result.ok) break;
    }
    const after = fingerprint(cwd);
    const receipt = { attempt: task.attempts, fingerprint: after, plan: digest(this.settings), passed: results.length > 0 && results.length === this.settings.commands.length && results.every(r => r.passed) && before === after, results };
    if (before !== after) receipt.error = '検証中にソースが変更されました。再検証が必要です。';
    if (!results.length) receipt.error = '独立検証コマンドが未設定です。';
    this.repo.checkpoint(task.id, 'independent_verification', receipt);
    return receipt;
  }
  check(task) {
    if (!this.required) return { passed: true, failures: [] };
    const row = this.repo.store.get("SELECT data FROM checkpoints WHERE task_id=? AND phase='independent_verification' ORDER BY id DESC LIMIT 1", [task.id]);
    let receipt;
    try { receipt = JSON.parse(row?.data || 'null'); } catch { receipt = null; }
    let valid = false;
    try { valid = receipt?.passed === true && receipt.attempt === task.attempts && receipt.plan === digest(this.settings) && receipt.fingerprint === fingerprint(task.work_dir || task.repo_path); } catch { }
    return { passed: valid, failures: valid ? [] : ['独立テスト未実行・失敗、または検証後にソース/検証設定が変更されています。'], receipt };
  }
}
