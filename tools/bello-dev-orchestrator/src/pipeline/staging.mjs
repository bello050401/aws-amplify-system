import { runProcess } from './process.mjs';
import { runGit, pushVerifiedStaging } from '../core/git.mjs';
import { redactText } from '../log/redact.mjs';

const risky = /(^|\/)(amplify|migrations?|aws-setup)(\/|$)|(^|\/)(amplify\.yml|.*(?:iam|cognito|s3-policy).*\.(?:json|ya?ml|ts|ps1))$/i;
export function stagingPolicy(settings, task, changedFiles) {
  if (!settings.enabled) return 'staging反映が無効です';
  if (!settings.isolatedDataConfirmed) return 'staging専用データであることの確認が必要です';
  if (!/^[a-z0-9]+$/.test(settings.appId || '') || !/^\d{12}$/.test(settings.accountId || '')) return 'stagingのアプリID・AWSアカウントIDが未設定です';
  if (!/^(staging|stage|preview)(?:[-/][A-Za-z0-9._-]+)?$/.test(settings.branch || '')) return '許可されたstagingブランチ名ではありません';
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(settings.repository || '')) return 'stagingリポジトリが未設定です';
  if (task.isolation !== 'worktree' || !/^[a-f0-9]{40}$/.test(task.git_end_commit || '')) return '専用worktree上の確定コミットが必要です';
  if (changedFiles.some(file => risky.test(file))) return 'インフラ・データ構造の変更を含むため、承認前の自動反映を停止しました';
  return null;
}

// Only these read operations and the explicit staging release are exposed. No IAM, S3,
// Cognito, migration, create/update/delete-resource API exists in this adapter.
export class AmplifyStaging {
  constructor({ settings, execute = runProcess }) { this.settings = settings; this.execute = execute; }
  async call(operation, args = []) {
    if (!['get-app','get-branch','start-job','get-job'].includes(operation)) throw new Error('許可されていないAmplify操作です');
    const s = this.settings;
    const result = await this.execute({ file: 'aws', args: ['amplify', operation, '--app-id', s.appId, ...args, '--region', s.region, ...(s.profile ? ['--profile', s.profile] : []), '--output','json','--no-cli-pager'], env: { ...process.env, AWS_PAGER: '' }, timeoutMs: 30000 });
    if (!result.ok) throw new Error(`Amplify ${operation} に失敗しました`);
    return JSON.parse(result.stdout);
  }
  async preflight() {
    const s = this.settings;
    const { app } = await this.call('get-app');
    const { branch } = await this.call('get-branch', ['--branch-name', s.branch]);
    if (!app.appArn?.includes(`:${s.accountId}:apps/${s.appId}`) || app.repository?.replace(/\.git$/,'') !== s.repository.replace(/\.git$/,'')) throw new Error('stagingアプリのアカウントまたはリポジトリが設定と一致しません');
    if (branch.stage !== 'DEVELOPMENT' || branch.branchName !== s.branch || branch.enableAutoBuild) throw new Error('DEVELOPMENT・自動ビルド無効の専用ブランチのみ反映できます');
    const buildSpec = branch.buildSpec || app.buildSpec || '';
    if (/backend\s*:|pipeline-deploy|ampx|cloudformation|\bterraform\b/i.test(buildSpec)) throw new Error('バックエンド変更を実行するビルド設定は承認前に反映できません');
  }
  async start(commit) {
    const response = await this.call('start-job', ['--branch-name', this.settings.branch, '--job-type','RELEASE','--commit-id',commit,'--job-reason','BELLO verified staging release']);
    return response.jobSummary.jobId;
  }
  async poll(jobId) { return (await this.call('get-job', ['--branch-name', this.settings.branch, '--job-id', jobId])).job.summary; }
}

export class StagingDelivery {
  constructor({ config, repo, verifier, adapterFactory = settings => new AmplifyStaging({ settings }), git = runGit, publish = pushVerifiedStaging }) { this.settings = structuredClone(config.staging ?? { enabled:false }); this.repo = repo; this.verifier = verifier; this.adapterFactory = adapterFactory; this.git = git; this.publish = publish; }
  prepare(task) {
    if (!task.work_dir) return { state: 'blocked', error: '専用worktreeがありません' };
    const changed = this.git(task.work_dir, ['diff', '--name-only', task.base_commit, task.git_end_commit]);
    let error = !changed.ok ? '反映差分を取得できません' : stagingPolicy(this.settings, task, changed.stdout.split(/\r?\n/).filter(Boolean));
    if (!error && (!this.verifier.required || !this.verifier.check(task).passed)) error = '独立検証の成功が必要です';
    const clean = this.git(task.work_dir, ['status','--porcelain']);
    if (!clean.ok || clean.stdout) error = '未コミット変更があるため反映できません';
    const spec = this.git(task.work_dir, ['show', `${task.git_end_commit}:amplify.yml`]);
    if (spec.ok && /backend\s*:|pipeline-deploy|ampx|cloudformation|\bterraform\b/i.test(spec.stdout)) error = 'amplify.ymlがバックエンドを反映するため、承認前の自動反映を停止しました';
    const workflows = this.git(task.work_dir, ['ls-tree', '-r', '--name-only', task.git_end_commit, '.github/workflows']);
    if (!workflows.ok || workflows.stdout.trim()) error = 'pushで起動するGitHubワークフローの影響確認が必要です';
    const existing = this.repo.store.get('SELECT * FROM staging_deliveries WHERE task_id=?', [task.id]);
    if (existing && ['starting','running'].includes(existing.state)) return existing;
    const now = new Date().toISOString();
    this.repo.store.run('INSERT INTO staging_deliveries(task_id,commit_id,config_json,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_id=excluded.commit_id,config_json=excluded.config_json,state=excluded.state,error=excluded.error,job_id=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at', [task.id, task.git_end_commit || '', JSON.stringify(this.settings), error ? 'blocked' : 'ready', error, now, now]);
    return this.repo.store.get('SELECT * FROM staging_deliveries WHERE task_id=?', [task.id]);
  }
  async advance(task) {
    const row = this.repo.store.get('SELECT * FROM staging_deliveries WHERE task_id=?', [task.id]);
    if (!row) return { state:'blocked', error:'反映記録がありません' };
    if (row.state === 'succeeded' || row.state === 'blocked' || row.state === 'failed') return row;
    const settings = JSON.parse(row.config_json);
    const update = (state, error = null, jobId = row.job_id) => {
      this.repo.store.run('UPDATE staging_deliveries SET state=?,error=?,job_id=?,updated_at=? WHERE task_id=?', [state, error && redactText(error), jobId, new Date().toISOString(), task.id]);
      return { state, error, job_id: jobId };
    };
    if (!this.settings.enabled || JSON.stringify(settings) !== JSON.stringify(this.settings)) return update('blocked', 'staging設定が変更または無効化されたため再確認が必要です');
    if (row.state === 'starting') return update('blocked', '起動要求の応答前に中断しました。重複反映を避けるためジョブ確認が必要です');
    const adapter = this.adapterFactory(settings);
    try {
      if (row.state === 'ready') {
        if (!this.verifier.check(task).passed) return update('blocked','検証後にソースが変わりました');
        await adapter.preflight();
        const remote = this.git(task.work_dir, ['ls-remote', settings.repository, `refs/heads/${settings.branch}`]);
        const previousCommit = remote.stdout?.split(/\s/)[0];
        if (!remote.ok || !/^[a-f0-9]{40}$/.test(previousCommit || '')) return update('blocked', 'stagingリモートブランチを確認できません');
        if (previousCommit !== row.commit_id) {
          const published = this.publish({ repoPath: task.work_dir, repository: settings.repository, branch: settings.branch, commit: row.commit_id, previousCommit });
          if (!published.ok) return update('blocked', 'stagingブランチを安全に更新できません。競合または認証を確認してください');
          const confirmed = this.git(task.work_dir, ['ls-remote', settings.repository, `refs/heads/${settings.branch}`]);
          if (!confirmed.ok || confirmed.stdout.split(/\s/)[0] !== row.commit_id) return update('blocked', 'stagingブランチの更新結果を確認できません');
        }
        update('starting'); // persist BEFORE non-idempotent API call
        const jobId = await adapter.start(row.commit_id);
        return update('running', null, jobId);
      }
      const job = await adapter.poll(row.job_id);
      if (job.commitId !== row.commit_id) return update('blocked', '反映ジョブのコミットが検証対象と一致しません');
      if (job.status === 'SUCCEED') return update('succeeded');
      if (['FAILED','CANCELLED'].includes(job.status)) return update('failed', `staging ${job.status}`);
      if (Date.now() - Date.parse(row.created_at) > (settings.maxWaitSeconds || 1800) * 1000) return update('blocked', 'staging完了待ちの上限を超えました。既存ジョブを確認してください');
      return row;
    } catch (err) {
      // If dispatch could have reached AWS, never retry it automatically.
      const current = this.repo.store.get('SELECT state FROM staging_deliveries WHERE task_id=?',[task.id]);
      if (current.state === 'starting') return update('blocked', '起動結果が不明です。既存ジョブを確認してください');
      if (current.state === 'running' && Date.now() - Date.parse(row.created_at) <= (settings.maxWaitSeconds || 1800) * 1000) return update('running', 'ジョブ状態の取得に失敗しました。次の確認で再試行します');
      return update('blocked', err.message);
    }
  }
}
