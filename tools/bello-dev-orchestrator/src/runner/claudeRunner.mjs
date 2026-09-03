/**
 * Claude Runner (指示書 §6)。
 *
 * 実測にもとづく呼び出し方（docs/ADR-0001 §4、evidence/claude-runner-smoke.json）:
 *   claude -p --output-format json --json-schema <schema> --permission-mode ... --permission-prompts none
 * 指示本文はコマンドライン引数へ埋め込まず、標準入力から渡す (§6-2)。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMPLETION_REPORT_SCHEMA, buildExecutionContract } from "./reportSchema.mjs";
import { validate } from "../core/validate.mjs";
import { redactCommand, redactText } from "../log/redact.mjs";

/** stdout をメモリに溜める上限。超えた分はファイルにだけ残す (§6-2 出力サイズ上限)。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const TERMINATION = Object.freeze({
  COMPLETED: "completed",
  TIMEOUT: "timeout",
  IDLE_TIMEOUT: "idle_timeout",
  STOPPED_BY_USER: "stopped_by_user",
  SPAWN_FAILED: "spawn_failed",
  CRASHED: "crashed",
});

/** claude 実行ファイルを解決する。設定 → PATH → ネイティブ既定位置の順。 */
export function resolveClaudeExecutable(configured) {
  if (configured && fs.existsSync(configured)) return { file: configured, kind: "configured" };

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const nativeCandidates = [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".local", "bin", "claude"),
  ];
  for (const candidate of nativeCandidates) {
    if (candidate && fs.existsSync(candidate)) return { file: candidate, kind: "native" };
  }

  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (which.status === 0) {
    const first = String(which.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (first && fs.existsSync(first.trim())) return { file: first.trim(), kind: "path" };
  }
  return null;
}

/**
 * Windows でプロセスツリーごと確実に止める (§6-2「孤児プロセスを残さない」)。
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 既に終了 */
      }
    }
  }
}

/**
 * プロセスがまだ「働いている」かを見る。無出力だけで殺さないため (§6-2)。
 * 戻り値 { alive, cpuMs, childCount }。取得できない項目は null。
 */
function sampleProcess(pid) {
  if (process.platform !== "win32") {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    return { alive, cpuMs: null, childCount: null };
  }
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;` +
        `if (-not $p) { '{"alive":false}' } else {` +
        `$c = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -ErrorAction SilentlyContinue).Count;` +
        `$cpu = [double]($p.KernelModeTime + $p.UserModeTime) / 10000;` +
        `'{"alive":true,"cpuMs":' + [math]::Round($cpu) + ',"childCount":' + $c + '}' }`,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  try {
    return { childCount: null, cpuMs: null, ...JSON.parse(String(ps.stdout || "").trim()) };
  } catch {
    return { alive: true, cpuMs: null, childCount: null };
  }
}

export class ClaudeRunner {
  constructor({ config, paths, logger }) {
    this.config = config;
    this.paths = paths;
    this.logger = logger;
  }

  buildArgs({ resumeSessionId }) {
    const c = this.config.claude;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(COMPLETION_REPORT_SCHEMA),
      "--permission-mode",
      c.permissionMode,
      "--permission-prompts",
      c.permissionPrompts,
    ];
    if (c.model) args.push("--model", c.model);

    // 実測 (docs/ADR-0001 §4): --permission-prompts none だけでは Bash が
    // 「承認できる主体が居ない」として自動拒否され、テストもビルドも走らない。
    // bypassPermissions で全部素通しにするのは指示書 §12 に反するので、
    // 許可したいコマンドだけを明示する最小権限方式にする。
    if (Array.isArray(c.allowedTools) && c.allowedTools.length > 0) {
      args.push("--allowedTools", c.allowedTools.join(","));
    }
    // 拒否リストは許可リストより強い。破壊的・不可逆な操作をここで塞ぐ。
    if (Array.isArray(c.disallowedTools) && c.disallowedTools.length > 0) {
      args.push("--disallowedTools", c.disallowedTools.join(","));
    }

    if (Number.isFinite(c.maxBudgetUsd) && c.maxBudgetUsd > 0) {
      args.push("--max-budget-usd", String(c.maxBudgetUsd));
    }
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (Array.isArray(c.extraArgs)) args.push(...c.extraArgs);
    return args;
  }

  /**
   * 1 タスクを実行する。
   * onHeartbeat は出力があるたびに呼ばれる (状態の heartbeat_at 更新用)。
   * shouldStop() が true を返したら安全に停止する (ダッシュボードの停止操作)。
   */
  async run({ task, instruction, resumeSessionId = null, onHeartbeat = () => {}, shouldStop = () => false }) {
    const resolved = resolveClaudeExecutable(this.config.claude.executable);
    if (!resolved) {
      return {
        ok: false,
        terminationReason: TERMINATION.SPAWN_FAILED,
        error: "claude 実行ファイルが見つかりません。設定 claude.executable を確認してください。",
        exitCode: null,
      };
    }

    const runDir = path.join(this.paths.runsDir, task.id);
    fs.mkdirSync(runDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stdoutPath = path.join(runDir, `attempt-${task.attempts + 1}-${stamp}.stdout.log`);
    const stderrPath = path.join(runDir, `attempt-${task.attempts + 1}-${stamp}.stderr.log`);
    const promptPath = path.join(runDir, `attempt-${task.attempts + 1}-${stamp}.prompt.txt`);

    const fullPrompt = buildExecutionContract({
      taskId: task.id,
      repoPath: task.repo_path,
      branch: task.branch,
      workDir: task.work_dir || task.repo_path,
      isolation: task.isolation,
      baseCommit: task.base_commit,
    }) + instruction;

    // 指示本文はコマンドラインへ出さない。証拠として保存はする (秘密除去済み)。
    fs.writeFileSync(promptPath, redactText(fullPrompt), "utf8");

    const args = this.buildArgs({ resumeSessionId });
    this.logger.info("Claude Runner 起動", {
      taskId: task.id,
      command: redactCommand(resolved.file, args.map((a) => (a.length > 120 ? "<schema>" : a))),
      cwd: task.work_dir || task.repo_path,
      stdoutPath,
    });

    const child = spawn(resolved.file, args, {
      cwd: task.work_dir || task.repo_path,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#childEnv(),
    });

    const outStream = fs.createWriteStream(stdoutPath, { flags: "a" });
    const errStream = fs.createWriteStream(stderrPath, { flags: "a" });

    let stdoutBuf = "";
    let stdoutBytes = 0;
    let stderrTail = "";
    let lastOutputAt = Date.now();
    let truncated = false;

    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      outStream.write(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdoutBuf += chunk.toString("utf8");
      else truncated = true;
      onHeartbeat();
    });
    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      errStream.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
      onHeartbeat();
    });

    // 指示は stdin から渡す (§6-2)
    try {
      child.stdin.end(fullPrompt, "utf8");
    } catch (err) {
      this.logger.warn("stdin へ指示を書けませんでした", { error: err.message });
    }

    const startedAt = Date.now();
    const startedPid = child.pid;
    let terminationReason = TERMINATION.COMPLETED;
    let idleStrikes = 0;
    let lastCpuMs = null;

    const exitInfo = await new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve(payload);
      };

      child.on("error", (err) => {
        terminationReason = TERMINATION.SPAWN_FAILED;
        finish({ code: null, signal: null, error: err.message });
      });
      child.on("close", (code, signal) => finish({ code, signal, error: null }));

      const timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const idle = (Date.now() - lastOutputAt) / 1000;

        if (shouldStop()) {
          terminationReason = TERMINATION.STOPPED_BY_USER;
          killTree(startedPid);
          return;
        }
        if (elapsed > this.config.claude.timeoutSeconds) {
          terminationReason = TERMINATION.TIMEOUT;
          this.logger.warn("Claude 実行が全体タイムアウトに達しました", { taskId: task.id, elapsed });
          killTree(startedPid);
          return;
        }
        if (idle > this.config.claude.idleTimeoutSeconds) {
          // 無出力だけでは殺さない。CPU と子プロセスを見て「本当に止まっているか」を確かめる。
          const sample = sampleProcess(startedPid);
          const cpuAdvanced = sample.cpuMs != null && lastCpuMs != null && sample.cpuMs > lastCpuMs + 50;
          const hasChildren = (sample.childCount ?? 0) > 0;
          lastCpuMs = sample.cpuMs ?? lastCpuMs;

          if (!sample.alive) return; // close イベントが来る
          if (cpuAdvanced || hasChildren) {
            idleStrikes = 0;
            this.logger.debug("無出力だが動作中と判断し継続", {
              taskId: task.id,
              idleSeconds: Math.round(idle),
              cpuMs: sample.cpuMs,
              childCount: sample.childCount,
            });
            return;
          }
          idleStrikes += 1;
          this.logger.warn("Claude が無出力・無活動です", { taskId: task.id, idleStrikes });
          if (idleStrikes >= 2) {
            terminationReason = TERMINATION.IDLE_TIMEOUT;
            killTree(startedPid);
          }
        }
      }, 30000);
    });

    outStream.end();
    errStream.end();

    if (exitInfo.error && terminationReason === TERMINATION.SPAWN_FAILED) {
      return {
        ok: false,
        terminationReason,
        error: exitInfo.error,
        exitCode: null,
        stdoutPath,
        stderrPath,
        promptPath,
      };
    }

    const parsed = this.#parseResult(stdoutBuf);
    const exitCode = exitInfo.code;

    if (terminationReason === TERMINATION.COMPLETED && (exitCode !== 0 || parsed.envelope?.is_error)) {
      terminationReason = TERMINATION.CRASHED;
    }

    const result = {
      ok: false,
      terminationReason,
      exitCode,
      signal: exitInfo.signal ?? null,
      durationMs: Date.now() - startedAt,
      stdoutPath,
      stderrPath,
      promptPath,
      truncated,
      stderrTail: redactText(stderrTail),
      sessionId: parsed.envelope?.session_id ?? null,
      costUsd: parsed.envelope?.total_cost_usd ?? null,
      numTurns: parsed.envelope?.num_turns ?? null,
      permissionDenials: parsed.envelope?.permission_denials ?? [],
      report: null,
      reportErrors: [],
    };

    if (!parsed.envelope) {
      result.error = "Claude の出力を JSON として解釈できませんでした。";
      return result;
    }

    const report = parsed.structured;
    if (!report) {
      result.error = "完了報告 (structured_output) が返りませんでした。";
      return result;
    }

    const check = validate(report, COMPLETION_REPORT_SCHEMA);
    result.report = report;
    result.reportErrors = check.errors;
    result.ok = check.valid && terminationReason === TERMINATION.COMPLETED;
    return result;
  }

  /** 子プロセスへ渡す環境変数を必要最小限にする (§13-2)。 */
  #childEnv() {
    const allow = [
      "PATH",
      "Path",
      "SystemRoot",
      "windir",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
      "HOMEDRIVE",
      "HOMEPATH",
      "APPDATA",
      "LOCALAPPDATA",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMDATA",
      "COMSPEC",
      "PATHEXT",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "USERNAME",
      "COMPUTERNAME",
      "TZ",
    ];
    const env = {};
    for (const key of allow) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // Claude Code 自身の認証はキーチェーン/設定から読む。API キーは渡さない。
    env.CLAUDE_CODE_NONINTERACTIVE = "1";
    return env;
  }

  /**
   * --output-format json の出力を解釈する。
   * 前後に人間向けの行が混ざっても、最後の JSON オブジェクトを拾う。
   */
  #parseResult(stdout) {
    const text = String(stdout || "").trim();
    if (!text) return { envelope: null, structured: null };

    const tryParse = (candidate) => {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    };

    let envelope = tryParse(text);
    if (!envelope) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) envelope = tryParse(text.slice(start, end + 1));
    }
    if (!envelope || typeof envelope !== "object") return { envelope: null, structured: null };

    let structured = envelope.structured_output ?? null;
    if (!structured && typeof envelope.result === "string") structured = tryParse(envelope.result);
    return { envelope, structured };
  }
}
