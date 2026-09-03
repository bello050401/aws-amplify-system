/**
 * 自己診断 (指示書 §15 diagnose, §10-1-6 システム状態)。
 * 秘密値は「設定済みか」だけを返し、値そのものは絶対に返さない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeSqlite } from "./store/db.mjs";
import { resolveClaudeExecutable } from "./runner/claudeRunner.mjs";
import * as git from "./core/git.mjs";

function run(file, args, timeout = 20000) {
  const res = spawnSync(file, args, { encoding: "utf8", timeout, windowsHide: true });
  return { ok: res.status === 0, out: String(res.stdout ?? "").trim(), err: String(res.stderr ?? "").trim() };
}

export class Diagnostics {
  constructor({ config, paths, repo, logger }) {
    this.config = config;
    this.paths = paths;
    this.repo = repo;
    this.logger = logger;
  }

  isReviewConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  /** ディスク空き容量。取れない環境では null を返す (推測しない)。 */
  #diskFree() {
    try {
      const stat = fs.statfsSync(this.paths.dataRoot);
      return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    } catch {
      return null;
    }
  }

  #scheduledTask(taskPath, taskName) {
    if (process.platform !== "win32") return { supported: false };
    const ps = run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$t = Get-ScheduledTask -TaskPath '${taskPath}' -TaskName '${taskName}' -ErrorAction SilentlyContinue;` +
        `if (-not $t) { '{"registered":false}' } else {` +
        `$i = $t | Get-ScheduledTaskInfo;` +
        `$o = [ordered]@{registered=$true; state=[string]$t.State; lastRunTime=[string]$i.LastRunTime;` +
        `lastResult=('0x{0:X}' -f $i.LastTaskResult); nextRunTime=[string]$i.NextRunTime;` +
        `triggerCount=@($t.Triggers).Count};` +
        `$o | ConvertTo-Json -Compress }`,
    ]);
    try {
      return JSON.parse(ps.out);
    } catch {
      return { registered: false, error: ps.err || "タスク情報を取得できませんでした" };
    }
  }

  async report() {
    const sqlite = await probeSqlite();
    const claude = resolveClaudeExecutable(this.config.claude.executable);
    const claudeVersion = claude ? run(claude.file, ["--version"], 30000) : null;
    const nodeOk = run(process.execPath, ["--version"]);
    const gitVersion = run("git", ["--version"]);

    const repoOk = fs.existsSync(this.config.repoPath) && git.isGitRepo(this.config.repoPath);
    const branch = repoOk ? git.currentBranch(this.config.repoPath) : null;

    let dataWritable = true;
    try {
      const probeFile = path.join(this.paths.stateDir, ".write-probe");
      fs.mkdirSync(this.paths.stateDir, { recursive: true });
      fs.writeFileSync(probeFile, String(Date.now()));
      fs.rmSync(probeFile, { force: true });
    } catch {
      dataWritable = false;
    }

    const integrity = this.repo ? this.repo.store.integrityCheck() : { ok: null, detail: "未接続" };
    const counts = this.repo ? this.repo.countByState() : {};
    const openTodos = this.repo ? this.repo.listTodos({ status: "open" }).length : 0;

    return {
      generatedAt: new Date().toISOString(),
      host: { hostname: os.hostname(), platform: process.platform, release: os.release(), user: os.userInfo().username },
      node: { version: process.version, ok: nodeOk.ok },
      sqlite,
      git: { version: gitVersion.out, repoPath: this.config.repoPath, isRepo: repoOk, branch },
      claude: {
        found: Boolean(claude),
        path: claude?.file ?? null,
        kind: claude?.kind ?? null,
        version: claudeVersion?.out ?? null,
      },
      review: {
        provider: this.config.review.provider,
        // 値は返さない。設定済みかどうかだけ。
        apiKeyConfigured: this.isReviewConfigured(),
        model: this.config.review.model || process.env.OPENAI_MODEL || "(既定)",
      },
      dashboard: {
        host: this.config.dashboard.host,
        port: this.config.dashboard.port,
        lanAccess: this.config.dashboard.lanAccess,
        lanTokenConfigured: Boolean(process.env[this.config.dashboard.lanAccessTokenEnvVar]),
      },
      storage: {
        dataRoot: this.paths.dataRoot,
        writable: dataWritable,
        dbIntegrity: integrity,
        disk: this.#diskFree(),
      },
      scheduledTasks: {
        remoteControl: this.#scheduledTask("\\BELLO\\", "ClaudeCodeRemoteControl"),
        orchestrator: this.#scheduledTask("\\BELLO\\", "BelloDevOrchestrator"),
      },
      queue: { counts, openTodos },
    };
  }

  /** diagnose の結果から、人が読む要約行を作る。 */
  static summarize(report) {
    const lines = [];
    const mark = (ok) => (ok ? "[ OK ]" : "[NG  ]");
    lines.push(`${mark(report.node.ok)} Node.js ${report.node.version}`);
    lines.push(`${mark(report.sqlite.ok)} node:sqlite ${report.sqlite.ok ? "利用可能" : report.sqlite.reason}`);
    lines.push(`${mark(report.git.isRepo)} リポジトリ ${report.git.repoPath}${report.git.branch ? ` (${report.git.branch})` : ""}`);
    lines.push(`${mark(report.claude.found)} Claude Code ${report.claude.version ?? "見つかりません"}`);
    lines.push(
      `${mark(report.review.apiKeyConfigured)} OpenAI 審査 ${report.review.apiKeyConfigured ? "設定済み" : "未設定 (AI審査は待機状態になります)"}`,
    );
    lines.push(`${mark(report.storage.writable)} 実行時データ ${report.storage.dataRoot}`);
    lines.push(`${mark(report.storage.dbIntegrity.ok !== false)} DB 整合性 ${report.storage.dbIntegrity.detail}`);
    const rc = report.scheduledTasks.remoteControl;
    lines.push(
      `${mark(rc.registered)} Scheduled Task \\BELLO\\ClaudeCodeRemoteControl ${rc.registered ? `${rc.state} / 最終実行 ${rc.lastRunTime} / ${rc.lastResult}` : "未登録"}`,
    );
    const orch = report.scheduledTasks.orchestrator;
    lines.push(
      `${mark(orch.registered)} Scheduled Task \\BELLO\\BelloDevOrchestrator ${orch.registered ? `${orch.state} / 最終実行 ${orch.lastRunTime} / ${orch.lastResult}` : "未登録"}`,
    );
    lines.push(
      `[INFO] キュー ${JSON.stringify(report.queue.counts)} / 未完了 TODO ${report.queue.openTodos} 件`,
    );
    return lines;
  }
}
