/**
 * Claude Review Engine — 別の Claude Code セッションによる独立審査。
 *
 * 追加課金なしで運用するための既定の審査方式。OpenAI API は使わない。
 *
 * 実装担当との分離:
 *   - 実装セッションを `--resume` しない。毎回まっさらな `claude -p` を起動するので、
 *     審査担当は実装担当の思考過程も会話履歴も見ない。別 session_id になる。
 *   - 編集系ツール (Edit / Write / NotebookEdit) を `--disallowedTools` で塞ぐ。
 *     審査担当は 1 バイトもリポジトリを書き換えられない。
 *   - 許可するのは読み取りと、git の読み取り系・テスト実行だけ。
 *
 * 自己申告を信用しない:
 *   審査担当には「完了報告を鵜呑みにせず、自分で git diff とテストを確認せよ」と指示し、
 *   そのためのコマンドを許可リストで与える。確認できなかった項目は
 *   acceptanceCriteriaResults に result="unknown" として残させる。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REVIEW_SCHEMA, REVIEW_PROMPT_VERSION, buildClaudeReviewPrompt } from "./reviewSchema.mjs";
import { validate } from "../core/validate.mjs";
import { redactText, redactValue, redactCommand } from "../log/redact.mjs";
import { resolveClaudeExecutable } from "../runner/claudeRunner.mjs";
import { ReviewUnavailableError, REVIEW_FAILURE, classifyFailureText } from "./errors.mjs";

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 審査担当が使ってよいツール。書き換え系は 1 つも入れない。 */
export const DEFAULT_REVIEW_ALLOWED_TOOLS = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git rev-parse:*)",
  "Bash(git branch:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(find:*)",
  "Bash(rg:*)",
  "Bash(grep:*)",
  // テスト結果を自分で確かめられるようにする（自己申告を信用しないため）
  "Bash(node --test:*)",
  "Bash(npm run test:*)",
  "Bash(npm test:*)",
  "Bash(npm run lint:*)",
  "Bash(npm run typecheck:*)",
]);

/** 許可リストより強い拒否。審査担当が実装してしまう事故を確実に防ぐ。 */
export const DEFAULT_REVIEW_DISALLOWED_TOOLS = Object.freeze([
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git stash:*)",
  "Bash(git clean:*)",
  "Bash(git rebase:*)",
  "Bash(rm:*)",
  "Bash(mv:*)",
  "Bash(cp:*)",
  "Bash(npm install:*)",
  "Bash(npm publish:*)",
  "Bash(npx ampx:*)",
  "Bash(aws:*)",
  "Bash(gh:*)",
  "Bash(curl:*)",
]);

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 既に終了 */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 既に終了 */
    }
  }
}

export class ClaudeReviewEngine {
  constructor({ config, paths, logger }) {
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this.provider = "claude";
  }

  get settings() {
    return this.config.review.claude ?? {};
  }

  /** Claude Code があれば使える。API キーは不要。 */
  isConfigured() {
    return Boolean(resolveClaudeExecutable(this.config.claude?.executable));
  }

  buildArgs() {
    const s = this.settings;
    const allowed = s.allowedTools?.length ? s.allowedTools : DEFAULT_REVIEW_ALLOWED_TOOLS;
    const disallowed = s.disallowedTools?.length ? s.disallowedTools : DEFAULT_REVIEW_DISALLOWED_TOOLS;

    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(REVIEW_SCHEMA),
      // 実装セッションを継承しない = 独立した審査者
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      disallowed.join(","),
    ];
    if (s.model) args.push("--model", s.model);
    if (Number.isFinite(s.maxBudgetUsd) && s.maxBudgetUsd > 0) {
      args.push("--max-budget-usd", String(s.maxBudgetUsd));
    }
    return args;
  }

  /**
   * @returns {{review: object, meta: object}}
   * @throws {ReviewUnavailableError}
   */
  async review({ task, report, gitStat, testSummary, priorReviews }) {
    const resolved = resolveClaudeExecutable(this.config.claude?.executable);
    if (!resolved) {
      throw new ReviewUnavailableError(
        "claude 実行ファイルが見つからないため Claude 審査を実行できません。",
        REVIEW_FAILURE.NOT_CONFIGURED,
      );
    }

    const prompt = buildClaudeReviewPrompt({
      task,
      report,
      gitStat,
      testSummary,
      priorReviews,
      maxDiffChars: this.config.review.maxDiffChars,
    });

    const reviewDir = path.join(this.paths.runsDir, task.id, "review");
    fs.mkdirSync(reviewDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stdoutPath = path.join(reviewDir, `review-${stamp}.stdout.log`);
    const stderrPath = path.join(reviewDir, `review-${stamp}.stderr.log`);
    fs.writeFileSync(path.join(reviewDir, `review-${stamp}.prompt.txt`), redactText(prompt), "utf8");

    const args = this.buildArgs();
    this.logger?.info?.("審査担当 Claude を起動します（実装セッションとは別）", {
      taskId: task.id,
      command: redactCommand(resolved.file, args.map((a) => (a.length > 120 ? "<schema>" : a))),
      cwd: task.repo_path,
    });

    const timeoutSeconds = Number.isFinite(this.settings.timeoutSeconds) ? this.settings.timeoutSeconds : 900;
    const started = Date.now();

    const child = spawn(resolved.file, args, {
      cwd: task.repo_path,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#childEnv(),
    });

    const outStream = fs.createWriteStream(stdoutPath, { flags: "a" });
    const errStream = fs.createWriteStream(stderrPath, { flags: "a" });
    let stdout = "";
    let bytes = 0;
    let stderrTail = "";

    child.stdout.on("data", (chunk) => {
      outStream.write(chunk);
      bytes += chunk.length;
      if (bytes <= MAX_BUFFER_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      errStream.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
    });

    try {
      child.stdin.end(prompt, "utf8");
    } catch (err) {
      this.logger?.warn?.("審査プロンプトを stdin へ書けませんでした", { error: err.message });
    }

    let timedOut = false;
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutSeconds * 1000);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, error: null });
      });
    });

    outStream.end();
    errStream.end();

    if (timedOut) {
      throw new ReviewUnavailableError(
        `審査担当 Claude が ${timeoutSeconds} 秒でタイムアウトしました。`,
        REVIEW_FAILURE.TRANSIENT,
      );
    }
    if (exit.error) {
      throw new ReviewUnavailableError(
        `審査担当 Claude を起動できません: ${redactText(exit.error)}`,
        REVIEW_FAILURE.NOT_CONFIGURED,
      );
    }

    const envelope = this.#parseEnvelope(stdout);
    const combined = `${stderrTail}\n${envelope ? JSON.stringify(envelope.result ?? "") : stdout.slice(0, 4000)}`;

    if (!envelope) {
      throw new ReviewUnavailableError(
        `審査担当 Claude の出力を解釈できません (exit ${exit.code}): ${redactText(combined).slice(0, 400)}`,
        exit.code === 0 ? REVIEW_FAILURE.REVIEW_FAILED : classifyFailureText(combined),
      );
    }
    if (envelope.is_error || exit.code !== 0) {
      throw new ReviewUnavailableError(
        `審査担当 Claude が失敗しました (exit ${exit.code}, subtype ${envelope.subtype ?? "-"}): ${redactText(
          String(envelope.result ?? combined),
        ).slice(0, 400)}`,
        classifyFailureText(`${envelope.subtype ?? ""} ${envelope.result ?? ""} ${combined}`),
      );
    }

    const parsed = envelope.structured_output ?? this.#tryParse(envelope.result);
    if (!parsed) {
      throw new ReviewUnavailableError(
        "審査担当 Claude が構造化された審査結果を返しませんでした。",
        REVIEW_FAILURE.REVIEW_FAILED,
      );
    }

    const check = validate(parsed, REVIEW_SCHEMA);
    if (!check.valid) {
      throw new ReviewUnavailableError(
        `審査結果がスキーマに適合しません: ${check.errors.slice(0, 5).join(" / ")}`,
        REVIEW_FAILURE.REVIEW_FAILED,
      );
    }

    // 審査担当が実装してしまっていないことを機械的に確認する。
    // 指示や許可リストを信じるだけにせず、実際の権限拒否記録を見る。
    const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [];
    const wroteSomething = denials.length === 0 ? null : denials;

    this.logger?.info?.("審査担当 Claude が完了しました", {
      taskId: task.id,
      reviewerSessionId: envelope.session_id ?? null,
      implementerSessionId: task.session_id ?? null,
      decision: parsed.decision,
      confidence: parsed.confidence,
      durationMs: Date.now() - started,
      costUsd: envelope.total_cost_usd ?? null,
      deniedToolUses: denials.length,
    });

    return {
      review: parsed,
      meta: {
        model: envelope.modelUsage ? Object.keys(envelope.modelUsage)[0] : (this.settings.model ?? null),
        promptVersion: REVIEW_PROMPT_VERSION,
        provider: this.provider,
        usage: redactValue({
          reviewerSessionId: envelope.session_id ?? null,
          implementerSessionId: task.session_id ?? null,
          sessionsAreSeparate: Boolean(envelope.session_id) && envelope.session_id !== task.session_id,
          numTurns: envelope.num_turns ?? null,
          costUsd: envelope.total_cost_usd ?? null,
          durationMs: Date.now() - started,
          deniedToolUses: wroteSomething,
          stdoutPath,
        }),
        attempts: 1,
      },
    };
  }

  #tryParse(text) {
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  #parseEnvelope(stdout) {
    const text = String(stdout || "").trim();
    if (!text) return null;
    const direct = this.#tryParse(text);
    if (direct && typeof direct === "object") return direct;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = this.#tryParse(text.slice(start, end + 1));
      if (sliced && typeof sliced === "object") return sliced;
    }
    return null;
  }

  /** 子プロセスへ渡す環境変数は最小限。API キーは渡さない。 */
  #childEnv() {
    const allow = [
      "PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "HOME",
      "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
      "PROGRAMDATA", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "OS",
      "PROCESSOR_ARCHITECTURE", "USERNAME", "COMPUTERNAME", "TZ",
    ];
    const env = {};
    for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.CLAUDE_CODE_NONINTERACTIVE = "1";
    return env;
  }
}
