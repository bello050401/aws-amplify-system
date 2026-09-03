/**
 * Orchestrator (指示書 §3-2, §5, §6-3, §7-4)。
 *
 * 1 タスクの一生を進める。状態遷移は必ず repo.setState (= 遷移表) を通す。
 * 実行は tick() 単位に分けてあり、テストから 1 手ずつ進められる。
 */
import crypto from "node:crypto";
import { STATES, ACTIVE_STATES } from "./states.mjs";
import * as git from "./git.mjs";
import { evaluateEvidence } from "../review/evidenceGate.mjs";
import { ReviewUnavailableError } from "../review/openaiReview.mjs";
import { redactText } from "../log/redact.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 審査できなかったタスクを次に見に行くまでの間隔。キー設定後 1 分以内に流れる。 */
const REVIEW_RECHECK_MS = 60_000;

function failureSignature(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

export class Orchestrator {
  constructor({ config, paths, repo, logger, runner, reviewEngine, todoManager }) {
    this.config = config;
    this.paths = paths;
    this.repo = repo;
    this.logger = logger;
    this.runner = runner;
    this.reviewEngine = reviewEngine;
    this.todoManager = todoManager;

    this.paused = false;
    this.stopping = false;
    this.currentTaskId = null;
    this.stopCurrentRequested = false;
    this.snapshots = new Map(); // taskId -> git snapshot
  }

  // ------------------------------------------------------------- recovery
  /**
   * 起動時復旧 (§6-3)。前回 running のまま落ちたタスクを安全な状態へ戻す。
   * プロセスは既に無いので「実行中」を名乗り続けさせない。
   */
  async recover() {
    const integrity = this.repo.store.integrityCheck();
    if (!integrity.ok) {
      this.logger.error("DB の整合性検査に失敗しました", { detail: integrity.detail });
      throw new Error(`永続ストアが壊れています: ${integrity.detail}`);
    }

    // 審査待ちで止まっていたものは作り直さない。待機指示だけ消して、
    // 起動直後に審査へ進めるようにする。
    for (const waiting of this.repo.listTasks({ state: STATES.AWAITING_AI_REVIEW, limit: 500 })) {
      if (waiting.retry_after) this.repo.updateTask(waiting.id, { retry_after: null });
    }

    // 完了報告が残っている verifying は、Claude を走らせ直さずに審査から再開する。
    let resumed = 0;
    for (const task of this.repo.listTasks({ state: STATES.VERIFYING, limit: 500 })) {
      if (task.report_id) {
        this.repo.setState(task.id, STATES.AWAITING_AI_REVIEW, "検証中に中断。完了報告が残っているため審査から再開します。", "recovery");
        this.repo.checkpoint(task.id, "recovery", { previousState: STATES.VERIFYING, resumedFrom: "report" });
        resumed += 1;
      } else {
        this.repo.setState(task.id, STATES.RETRY_WAIT, "検証中に中断。完了報告が無いため再実行します。", "recovery", {
          retry_after: new Date(Date.now() + 5000).toISOString(),
        });
      }
    }
    if (resumed) this.logger.info("完了報告が残っていたタスクを審査から再開します", { count: resumed });

    const stranded = [];
    for (const state of ACTIVE_STATES) {
      stranded.push(...this.repo.listTasks({ state, limit: 500 }));
    }

    for (const task of stranded) {
      // Claude セッションが残っていても、監督プロセスが死んだ時点で追跡不能。
      // 二重実行を避けるため、必ず新しい試行として作り直す (§6-3-6)。
      const canRetry = task.attempts < task.max_attempts;
      const reason = `Orchestrator の異常終了から復旧: 直前の状態 ${task.state}`;
      this.repo.checkpoint(task.id, "recovery", {
        previousState: task.state,
        attempts: task.attempts,
        sessionId: task.session_id,
      });

      if (canRetry) {
        this.repo.setState(task.id, STATES.RETRY_WAIT, reason, "recovery", {
          retry_after: new Date(Date.now() + 5000).toISOString(),
          blocked_reason: null,
        });
      } else {
        this.repo.setState(task.id, STATES.AWAITING_USER, `${reason} / 再試行上限に到達`, "recovery", {
          blocked_reason: "再試行上限に到達したまま中断しました。内容を確認してください。",
        });
        this.todoManager.createFromUserAction(
          {
            category: "approval",
            title: `中断したタスクの扱いを決めてください: ${task.title}`,
            reason: "Orchestrator が異常終了し、再試行上限にも達しています。継続するか取り消すか判断が必要です。",
            steps: ["ダッシュボードのタスク詳細でログと完了報告を確認する", "再試行するか取り消すかを選ぶ"],
            completionCondition: "タスクを再試行または取消にしたこと",
            canUseIPhone: true,
            estimatedMinutes: 5,
          },
          { waitingTaskIds: [task.id], source: "recovery" },
        );
      }
      this.repo.audit("recovery", "task.recovered", task.id, task.state, reason);
    }

    if (stranded.length) {
      this.logger.warn("中断タスクを復旧しました", { count: stranded.length, ids: stranded.map((t) => t.id) });
    }
    return stranded.length;
  }

  // ----------------------------------------------------------------- loop
  async runLoop() {
    this.logger.info("Orchestrator ループを開始します");
    while (!this.stopping) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (err) {
        this.logger.error("tick で未処理の例外", { error: err.message, stack: err.stack });
        await sleep(5000);
      }
      if (!didWork) await sleep(this.config.queue.pollIntervalSeconds * 1000);
    }
    this.logger.info("Orchestrator ループを終了しました");
  }

  stop() {
    this.stopping = true;
    this.stopCurrentRequested = true;
  }

  pause() {
    this.paused = true;
    this.repo.audit("user", "orchestrator.pause", null, "ok", null);
  }

  resume() {
    this.paused = false;
    this.repo.audit("user", "orchestrator.resume", null, "ok", null);
  }

  requestStopCurrent() {
    this.stopCurrentRequested = true;
    this.repo.audit("user", "task.stop_requested", this.currentTaskId, "ok", null);
  }

  /**
   * 1 手進める。何かしたら true を返す。
   */
  async tick() {
    this.repo.releaseDueRetries();
    if (this.paused) return false;

    // 1) AI 審査待ちを先に片付ける。API 復旧後に自動で流れるようにするため。
    //    claimNextReview は retry_after を尊重するので、キーが無い間や API 障害中に
    //    同じタスクを掴み続けてループが空転することはない。
    const awaitingReview = this.repo.claimNextReview();
    if (awaitingReview) {
      await this.#doReview(awaitingReview);
      return true;
    }

    // 2) 新しいタスクを 1 件実行する。
    const task = this.repo.claimNextTask();
    if (!task) return false;

    await this.#runTask(task);
    return true;
  }

  // ------------------------------------------------------------ execution
  async #runTask(task) {
    this.currentTaskId = task.id;
    this.stopCurrentRequested = false;

    try {
      // --- preflight -----------------------------------------------------
      this.repo.setState(task.id, STATES.PREFLIGHT, "事前確認", "system");
      const repoPath = task.repo_path;

      if (!git.isGitRepo(repoPath)) {
        return this.#failTask(task, `repoPath が git 作業ツリーではありません: ${repoPath}`, "preflight");
      }

      const snapshot = git.snapshotWorkingTree(repoPath);
      this.snapshots.set(task.id, snapshot);
      this.repo.checkpoint(task.id, "preflight", snapshot);
      this.repo.updateTask(task.id, {
        branch: snapshot.branch,
        git_start_commit: snapshot.headCommit,
        attempts: task.attempts + 1,
      });
      if (snapshot.dirty) {
        this.logger.info("開始時に未コミット変更があります。自動コミット対象から除外します。", {
          taskId: task.id,
          count: snapshot.entries.length,
        });
      }

      // --- running -------------------------------------------------------
      const running = this.repo.setState(task.id, STATES.RUNNING, "Claude Runner 実行", "system");
      const instruction = this.#buildInstruction(running);

      const result = await this.runner.run({
        task: running,
        instruction,
        resumeSessionId: null,
        onHeartbeat: () => this.repo.touchHeartbeat(task.id),
        shouldStop: () => this.stopCurrentRequested,
      });

      this.repo.updateTask(task.id, { session_id: result.sessionId ?? null });
      this.repo.checkpoint(task.id, "claude_finished", {
        terminationReason: result.terminationReason,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });

      if (this.stopCurrentRequested && !this.stopping) {
        this.repo.setState(task.id, STATES.PAUSED, "ユーザー操作により停止", "user");
        return;
      }

      if (!result.report) {
        return this.#retryOrFail(
          task,
          `Claude が完了報告を返しませんでした (${result.terminationReason}${result.error ? ": " + result.error : ""})`,
          failureSignature([result.terminationReason, result.error, result.stderrTail?.slice(0, 200)]),
        );
      }

      const reportId = this.repo.saveReport(task.id, task.attempts + 1, result.report, result.reportErrors.length === 0);

      if (result.reportErrors.length > 0) {
        return this.#retryOrFail(
          task,
          `完了報告がスキーマに適合しません: ${result.reportErrors.slice(0, 5).join(" / ")}`,
          failureSignature(["schema", ...result.reportErrors.slice(0, 3)]),
        );
      }

      // --- verifying (証拠ゲート: AI を使わない機械的突合) -----------------
      this.repo.setState(task.id, STATES.VERIFYING, "証拠を検証", "system");
      const gitFacts = {
        startCommit: snapshot.headCommit,
        headCommit: git.headCommit(repoPath),
        branch: git.currentBranch(repoPath),
        protectedBranchTouched:
          git.isProtectedBranch(git.currentBranch(repoPath), this.config.git.protectedBranches) &&
          git.headCommit(repoPath) !== snapshot.headCommit,
      };
      const evidence = evaluateEvidence({ report: result.report, gitFacts, repoPath });
      this.repo.checkpoint(task.id, "evidence_gate", evidence);

      const changed = git.changedFilesSince(repoPath, snapshot.headCommit);
      this.repo.updateTask(task.id, {
        changed_files: JSON.stringify(changed.slice(0, 500)),
        test_summary: JSON.stringify(result.report.tests ?? []),
        git_end_commit: gitFacts.headCommit,
      });

      // Claude が報告した本人操作を TODO 化する (§8)
      const todoIds = [];
      for (const action of result.report.userActions ?? []) {
        const { todo } = this.todoManager.createFromUserAction(action, {
          waitingTaskIds: [task.id],
          source: "claude",
        });
        todoIds.push(todo.id);
      }
      if (todoIds.length) this.repo.updateTask(task.id, { todo_ids: JSON.stringify(todoIds) });

      // 自動コミット (保護ブランチ・ユーザー変更は除外)
      if (this.config.git.autoCommit && evidence.passed) {
        const commit = git.commitTaskChanges({
          repoPath,
          branch: gitFacts.branch,
          message: `chore(orchestrator): ${task.title}\n\nTask: ${task.id}`,
          snapshot,
          protectedBranches: this.config.git.protectedBranches,
        });
        this.repo.checkpoint(task.id, "auto_commit", commit);
        if (commit.committed) {
          this.repo.updateTask(task.id, { git_end_commit: commit.commit });
          gitFacts.headCommit = commit.commit;
        }
      }

      this.repo.setState(task.id, STATES.AWAITING_AI_REVIEW, "AI 審査へ", "system", { report_id: reportId });
      await this.#doReview(this.repo.getTask(task.id), { evidence, gitFacts });
    } finally {
      this.currentTaskId = null;
    }
  }

  #buildInstruction(task) {
    const parts = [task.instruction];
    // 修正指示があれば付ける (§7-3 nextClaudeInstruction)
    if (task.blocked_reason) parts.push(`\n\n## 前回の審査からの修正指示\n\n${task.blocked_reason}`);
    return parts.join("");
  }

  // -------------------------------------------------------------- review
  async #doReview(task, precomputed = null) {
    const reportRow = task.report_id ? this.repo.getReport(task.report_id) : null;
    const report = reportRow?.report ?? null;
    if (!report) {
      return this.#retryOrFail(task, "審査対象の完了報告が見つかりません。", failureSignature(["missing_report"]));
    }

    const snapshot = this.snapshots.get(task.id);
    const evidence =
      precomputed?.evidence ??
      evaluateEvidence({
        report,
        gitFacts: {
          startCommit: task.git_start_commit,
          headCommit: git.headCommit(task.repo_path),
          branch: task.branch,
          protectedBranchTouched: false,
        },
        repoPath: task.repo_path,
      });

    let reviewResult = null;
    try {
      reviewResult = await this.reviewEngine.review({
        task,
        report,
        gitStat: git.diffStat(task.repo_path, task.git_start_commit),
        testSummary: report.tests ?? [],
        priorReviews: this.repo.reviewsFor(task.id),
      });
    } catch (err) {
      // どちらの経路でも retry_after を必ず入れる。入れないと次の tick で
      // 同じタスクを掴み直し、ループが眠らずに回り続ける。
      const firstTime = !task.retry_after;
      if (err instanceof ReviewUnavailableError && err.reason === "no_api_key") {
        // キーが無くてもシステムは止めない (§7-1)。TODO を出して待つ。
        this.todoManager.ensureEnvironmentTodos();
        this.repo.updateTask(task.id, {
          blocked_reason: "OPENAI_API_KEY 未設定のため AI 審査待ちです。キーを設定すれば自動で審査へ進みます。",
          retry_after: new Date(Date.now() + REVIEW_RECHECK_MS).toISOString(),
        });
        if (firstTime) {
          this.repo.audit("review_engine", "review.unavailable", task.id, "no_api_key", null);
          this.logger.warn("AI 審査を実行できません (APIキー未設定)。審査待ちのまま保持し、1 分ごとに再確認します。", {
            taskId: task.id,
          });
        }
        return;
      }
      // API 障害は指数バックオフ後に再試行。ここでは審査待ちのまま置く。
      const waitMs = Math.min(
        this.config.review.baseBackoffSeconds * 1000 * 2 ** Math.min(task.revision_count, 6),
        this.config.review.maxBackoffSeconds * 1000,
      ) || REVIEW_RECHECK_MS;
      this.repo.audit("review_engine", "review.failed", task.id, "api_failure", err.message);
      this.logger.error("AI 審査に失敗しました。バックオフして再試行します。", {
        taskId: task.id,
        error: err.message,
        retryInSeconds: Math.round(waitMs / 1000),
      });
      this.repo.updateTask(task.id, {
        last_error: redactText(err.message),
        retry_after: new Date(Date.now() + waitMs).toISOString(),
      });
      return;
    }

    const { review, meta } = reviewResult;
    // 審査できたので待機指示は消す。残したまま次の状態へ行くと、後の再試行判定を狂わせる。
    this.repo.updateTask(task.id, { retry_after: null, last_error: null });
    const reviewId = this.repo.saveReview(task.id, task.report_id, review, meta);

    // ---- 証拠ゲートが AI より強い (§7-4) --------------------------------
    let decision = review.decision;
    let overrideReason = null;
    if (decision === "accept_and_continue" && !evidence.passed) {
      decision = "revision_required";
      overrideReason = `証拠ゲート不合格のため AI の accept を採用しません: ${evidence.failures.join(" / ")}`;
      this.repo.audit("system", "review.override", task.id, "accept->revision", overrideReason);
    }
    if (decision === "accept_and_continue" && review.confidence < this.config.review.minConfidenceToAccept) {
      decision = "pause_for_user_review";
      overrideReason = `審査の確信度が低い (${review.confidence}) ためレビュー待ちにします。`;
      this.repo.audit("system", "review.override", task.id, "accept->pause", overrideReason);
    }

    await this.#applyDecision(task, decision, review, { reviewId, evidence, overrideReason });
  }

  async #applyDecision(task, decision, review, { reviewId, evidence, overrideReason }) {
    const reason = overrideReason ? `${review.reason}\n(${overrideReason})` : review.reason;

    // 審査由来の TODO
    const todoIds = [...(task.todoIds ?? [])];
    for (const action of review.userTodos ?? []) {
      const { todo } = this.todoManager.createFromUserAction(action, {
        waitingTaskIds: [task.id],
        source: "review_engine",
      });
      todoIds.push(todo.id);
    }
    if (todoIds.length !== (task.todoIds ?? []).length) {
      this.repo.updateTask(task.id, { todo_ids: JSON.stringify([...new Set(todoIds)]) });
    }

    switch (decision) {
      case "accept_and_continue":
        this.repo.setState(task.id, STATES.COMPLETED, reason, "review_engine", {
          review_id: reviewId,
          blocked_reason: null,
          last_error: null,
        });
        this.logger.info("タスク完了", { taskId: task.id, title: task.title });
        return;

      case "revision_required": {
        const signature = failureSignature([
          "revision",
          ...(evidence?.failures ?? []),
          String(review.reason ?? "").slice(0, 200),
        ]);
        const sameAsBefore = task.last_failure_signature === signature;
        const nextRevision = task.revision_count + 1;

        if (nextRevision > task.max_revisions || sameAsBefore) {
          const why = sameAsBefore
            ? "同じ失敗理由が繰り返されたため自動修正を停止しました。"
            : `自動修正の上限 (${task.max_revisions} 回) に達しました。`;
          this.repo.setState(task.id, STATES.AWAITING_USER, `${why} ${reason}`, "review_engine", {
            review_id: reviewId,
            revision_count: nextRevision,
            last_failure_signature: signature,
            blocked_reason: why,
          });
          this.todoManager.createFromUserAction(
            {
              category: "specification_decision",
              title: `自動修正が収束しません: ${task.title}`,
              reason: `${why}\n審査コメント: ${review.reason}`,
              steps: ["ダッシュボードのタスク詳細で完了報告と審査履歴を確認する", "指示を具体化して再投入するか、取り消す"],
              completionCondition: "追加指示を入力するか、タスクを取り消したこと",
              answerFormat: "text",
              answerRequired: true,
              canUseIPhone: true,
              estimatedMinutes: 10,
              priority: "urgent",
            },
            { waitingTaskIds: [task.id], source: "review_engine" },
          );
          return;
        }

        this.repo.setState(task.id, STATES.REVISION_REQUIRED, reason, "review_engine", {
          review_id: reviewId,
          revision_count: nextRevision,
          last_failure_signature: signature,
          blocked_reason: review.nextClaudeInstruction ?? reason,
        });
        this.repo.setState(task.id, STATES.QUEUED, "修正指示で再実行", "review_engine");
        return;
      }

      case "request_user_action":
        this.repo.setState(task.id, STATES.AWAITING_USER, reason, "review_engine", {
          review_id: reviewId,
          blocked_reason: reason,
        });
        return;

      case "pause_for_user_review":
        this.repo.setState(task.id, STATES.PAUSED, reason, "review_engine", {
          review_id: reviewId,
          blocked_reason: reason,
        });
        return;

      case "fail_safely":
      default:
        this.repo.setState(task.id, STATES.FAILED, reason, "review_engine", {
          review_id: reviewId,
          blocked_reason: reason,
        });
        return;
    }
  }

  // ------------------------------------------------------------- failures
  #retryOrFail(task, message, signature) {
    const fresh = this.repo.getTask(task.id);
    const attempts = fresh.attempts;
    const sameAsBefore = fresh.last_failure_signature === signature;

    this.logger.warn("タスク実行に失敗しました", { taskId: task.id, attempts, message });
    this.repo.audit("system", "task.failure", task.id, `attempt ${attempts}`, message);

    if (attempts >= fresh.max_attempts || sameAsBefore) {
      const why = sameAsBefore
        ? "同じ失敗が繰り返されたため停止しました。"
        : `再試行上限 (${fresh.max_attempts} 回) に達しました。`;
      this.repo.setState(task.id, STATES.FAILED, `${why} ${message}`, "system", {
        last_error: redactText(message).slice(0, 4000),
        last_failure_signature: signature,
        blocked_reason: why,
      });
      this.todoManager.createFromUserAction(
        {
          category: "approval",
          title: `タスクが失敗しました: ${task.title}`,
          reason: `${why}\n直近のエラー: ${message}`,
          steps: ["ダッシュボードでログを確認する", "原因を直して再試行するか、取り消す"],
          completionCondition: "再試行または取消を行ったこと",
          canUseIPhone: true,
          estimatedMinutes: 10,
        },
        { waitingTaskIds: [task.id], source: "system" },
      );
      return;
    }

    const backoff = Math.min(
      this.config.queue.retryBaseSeconds * 2 ** Math.max(0, attempts - 1),
      this.config.queue.retryMaxSeconds,
    );
    this.repo.setState(task.id, STATES.RETRY_WAIT, message, "system", {
      last_error: redactText(message).slice(0, 4000),
      last_failure_signature: signature,
      retry_after: new Date(Date.now() + backoff * 1000).toISOString(),
    });
  }

  #failTask(task, message, phase) {
    this.repo.setState(task.id, STATES.FAILED, `${phase}: ${message}`, "system", {
      last_error: redactText(message).slice(0, 4000),
    });
  }
}
