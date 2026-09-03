/**
 * Orchestrator (指示書 §3-2, §5, §6-3, §7-4)。
 *
 * 1 タスクの一生を進める。状態遷移は必ず repo.setState (= 遷移表) を通す。
 * 実行は tick() 単位に分けてあり、テストから 1 手ずつ進められる。
 */
import crypto from "node:crypto";
import { STATES, ACTIVE_STATES } from "./states.mjs";
import * as git from "./git.mjs";
import {
  createTaskWorktree,
  removeWorktreeIfSafe,
  canRemoveWorktree,
  branchNameFor,
} from "./worktree.mjs";
import { evaluateEvidence } from "../review/evidenceGate.mjs";
import { ReviewUnavailableError, REVIEW_FAILURE, NEEDS_USER_ACTION, describeFailure } from "../review/errors.mjs";
import {
  MANUAL_REVIEW_TODO_KIND,
  buildManualReviewTodo,
  parseManualAnswer,
  toReviewRecord,
} from "../review/manualReview.mjs";
import { redactText } from "../log/redact.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 審査できなかったタスクを次に見に行くまでの間隔。キー設定後 1 分以内に流れる。 */
const REVIEW_RECHECK_MS = 60_000;

function failureSignature(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

export class Orchestrator {
  constructor({ config, paths, repo, logger, runner, reviewEngine, reviewEngines, todoManager }) {
    this.config = config;
    this.paths = paths;
    this.repo = repo;
    this.logger = logger;
    this.runner = runner;
    // 直接注入された 1 個のエンジン (テスト用)。あれば方式の選択より優先する。
    this.reviewEngine = reviewEngine;
    // 方式名 -> エンジン。本番はこちらを使い、ダッシュボードの選択で切り替える。
    this.reviewEngines = reviewEngines ?? {};
    this.todoManager = todoManager;

    // 手動審査の判定 (TODO の回答) を審査結果として取り込む。
    if (todoManager) {
      todoManager.onManualReview = (todo) => this.applyManualReview(todo);
    }

    // 前回の一時停止を引き継ぐ。設定破損などで止めた状態から再起動したとき、
    // 人が明示的に再開するまでタスクを掴まないようにするため。
    this.paused = typeof repo?.getPaused === "function" ? repo.getPaused() : false;
    this.stopping = false;
    this.currentTaskId = null;
    this.stopCurrentRequested = false;
    this.snapshots = new Map(); // taskId -> git snapshot
  }

  /**
   * いま使う審査方式。設定ファイルの値を既定に、ダッシュボードの選択 (meta) を優先する。
   * テストでエンジンを直接注入している場合はそちらを使う。
   */
  get reviewProvider() {
    if (this.reviewEngine) return this.reviewEngine.provider ?? "injected";
    return this.repo.getReviewProvider(this.config.review.provider);
  }

  /** 手動審査のときは null を返す (エンジンを呼ばず人に投げるため)。 */
  #resolveEngine(provider) {
    if (this.reviewEngine) return this.reviewEngine;
    if (provider === "manual") return null;
    const engine = this.reviewEngines[provider];
    if (!engine) {
      throw new ReviewUnavailableError(
        `審査方式「${provider}」に対応するエンジンがありません。ダッシュボードの設定で選び直してください。`,
        REVIEW_FAILURE.NOT_CONFIGURED,
      );
    }
    return engine;
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
    // 再起動を跨いで効かせる。監査ログは setPaused が書く。
    if (typeof this.repo.setPaused === "function") this.repo.setPaused(true, "user");
    else this.repo.audit("user", "orchestrator.pause", null, "ok", null);
  }

  resume() {
    this.paused = false;
    if (typeof this.repo.setPaused === "function") this.repo.setPaused(false, "user");
    else this.repo.audit("user", "orchestrator.resume", null, "ok", null);
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

      // 本体リポジトリの開始時点の状態を必ず記録する。
      // 「開始前から存在した未コミット変更」を後から証明できるようにするため。
      const snapshot = git.snapshotWorkingTree(repoPath);
      this.snapshots.set(task.id, snapshot);
      this.repo.checkpoint(task.id, "preflight", snapshot);
      if (snapshot.dirty) {
        this.logger.info("開始時に本体リポジトリへ未コミット変更があります。一切触りません。", {
          taskId: task.id,
          count: snapshot.entries.length,
          files: snapshot.entries.slice(0, 20),
        });
      }

      // タスク専用の作業場所を用意する。
      const place = this.#prepareWorkspace(task, snapshot);
      if (!place.ok) {
        return this.#failTask(task, place.reason, "preflight");
      }

      this.repo.updateTask(task.id, {
        branch: place.branch,
        git_start_commit: place.baseCommit,
        base_commit: place.baseCommit,
        base_branch: place.baseBranch,
        worktree_path: place.isolation === "worktree" ? place.workDir : null,
        worktree_branch: place.isolation === "worktree" ? place.branch : null,
        work_dir: place.workDir,
        isolation: place.isolation,
        attempts: task.attempts + 1,
      });
      this.repo.checkpoint(task.id, "workspace", {
        isolation: place.isolation,
        workDir: place.workDir,
        branch: place.branch,
        baseCommit: place.baseCommit,
        baseBranch: place.baseBranch,
        reused: place.reused ?? false,
      });

      // --- running -------------------------------------------------------
      const running = this.repo.setState(task.id, STATES.RUNNING, "Claude Runner 実行", "system");
      const instruction = this.#buildInstruction(running);

      // 実装担当は work_dir (= 専用 worktree) で動く。本体リポジトリには触れない。
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
      const workDir = place.workDir;
      const gitFacts = {
        startCommit: place.baseCommit,
        headCommit: git.headCommit(workDir),
        branch: git.currentBranch(workDir),
        protectedBranchTouched:
          git.isProtectedBranch(git.currentBranch(workDir), this.config.git.protectedBranches) &&
          git.headCommit(workDir) !== place.baseCommit,
      };
      const evidence = evaluateEvidence({ report: result.report, gitFacts, repoPath: workDir });
      this.repo.checkpoint(task.id, "evidence_gate", evidence);

      // worktree 方式では、ここで出るファイルは「このタスクが作ったもの」だけ。
      // 基準コミットのきれいな複製から始めているので、他人の変更は入りようがない。
      const changed =
        place.isolation === "worktree"
          ? git.taskChangedFilesInWorktree(workDir, place.baseCommit)
          : git.changedFilesSince(workDir, place.baseCommit).filter((f) => !git.preexistingPaths(snapshot).has(f));
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

      // 自動コミット。stage するのは「このタスクが作ったと証明できるファイル」だけ。
      if (this.config.git.autoCommit && evidence.passed) {
        const commit = git.commitTaskChanges({
          repoPath: workDir,
          branch: gitFacts.branch,
          message:
            `chore(orchestrator): ${task.title}\n\n` +
            `Task: ${task.id}\nIsolation: ${place.isolation}\nBase: ${place.baseCommit}`,
          snapshot: place.isolation === "worktree" ? { entries: [] } : snapshot,
          allowedFiles: changed,
          protectedBranches: this.config.git.protectedBranches,
        });
        this.repo.checkpoint(task.id, "auto_commit", commit);
        if (commit.committed) {
          this.repo.updateTask(task.id, { git_end_commit: commit.commit });
          gitFacts.headCommit = commit.commit;
        }
        if (commit.skipped?.length) {
          this.logger.info("コミット対象から除外したファイル", {
            taskId: task.id,
            skipped: commit.skipped.slice(0, 20),
          });
        }
      }

      // 別セッションが同じファイルを触っていないか調べる。自動マージはしない。
      this.#checkCrossSessionConflicts(task, place, changed);

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
          startCommit: task.base_commit || task.git_start_commit,
          headCommit: git.headCommit(task.work_dir || task.repo_path),
          branch: task.branch,
          protectedBranchTouched: false,
        },
        repoPath: task.work_dir || task.repo_path,
      });

    const provider = this.reviewProvider;

    // 手動審査: エンジンを呼ばず、人に判定を依頼する TODO を出して待つ。
    // 状態は awaiting_ai_review のまま保持する (審査を待っている点は同じ)。
    if (provider === "manual" && !this.reviewEngine) {
      const existing = this.repo.openTodosForTask(task.id, MANUAL_REVIEW_TODO_KIND);
      if (existing.length === 0) {
        const { todo } = this.todoManager.createFromUserAction(
          buildManualReviewTodo({ task, report, evidence }),
          { waitingTaskIds: [task.id], source: "manual_review" },
        );
        this.repo.updateTask(task.id, {
          blocked_reason: "手動審査の判定待ちです。ダッシュボードの TODO から判定してください。",
          retry_after: null,
        });
        this.repo.audit("system", "review.manual.requested", task.id, todo.id, null);
        this.logger.info("手動審査を依頼しました", { taskId: task.id, todoId: todo.id });
      }
      return;
    }

    let reviewResult = null;
    let engine = null;
    try {
      engine = this.#resolveEngine(provider);
      reviewResult = await engine.review({
        task,
        report,
        gitStat: git.diffStat(task.work_dir || task.repo_path, task.base_commit || task.git_start_commit),
        testSummary: report.tests ?? [],
        priorReviews: this.repo.reviewsFor(task.id),
      });
    } catch (err) {
      this.#handleReviewFailure(task, err, provider);
      return;
    }

    const { review, meta } = reviewResult;
    // 審査できたので待機指示と失敗カウンタは消す。残したまま次の状態へ行くと、
    // 後の再試行判定を狂わせる。審査失敗を知らせていた TODO も自動で閉じる。
    this.repo.updateTask(task.id, { retry_after: null, last_error: null, review_failures: 0 });
    this.#closeReviewFailureTodos(task.id);
    const reviewId = this.repo.saveReview(task.id, task.report_id, review, meta);

    const enforced = this.#enforceEvidenceGate(task, review, evidence);
    await this.#applyDecision(task, enforced.decision, review, {
      reviewId,
      evidence,
      overrideReason: enforced.overrideReason,
    });
  }

  /**
   * 証拠ゲートは審査者より強い (§7-4)。
   * AI が accept と言おうが、人が「合格」と打とうが、テストが通っていなければ通さない。
   * これは審査方式に関係なく共通で、Claude 審査 / OpenAI 審査 / 手動審査すべてに適用する。
   */
  #enforceEvidenceGate(task, review, evidence) {
    let decision = review.decision;
    let overrideReason = null;

    if (decision === "accept_and_continue" && evidence && !evidence.passed) {
      decision = "revision_required";
      overrideReason = `証拠ゲート不合格のため accept を採用しません: ${(evidence.failures ?? []).join(" / ")}`;
      this.repo.audit("system", "review.override", task.id, "accept->revision", overrideReason);
    }
    if (
      decision === "accept_and_continue" &&
      Number.isFinite(review.confidence) &&
      review.confidence < this.config.review.minConfidenceToAccept
    ) {
      decision = "pause_for_user_review";
      overrideReason = `審査の確信度が低い (${review.confidence}) ためレビュー待ちにします。`;
      this.repo.audit("system", "review.override", task.id, "accept->pause", overrideReason);
    }
    return { decision, overrideReason };
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

  // ------------------------------------------------- 作業場所の用意と後始末
  /**
   * タスク専用の作業場所を用意する。
   *
   * 既定は worktree 方式。基準コミットのきれいな複製から始めるので、
   * 開始前の未コミット変更は複製されず、触ることも巻き込むこともできない。
   * worktree を作れない環境では、設定次第で同一ツリー方式へ落ちる。
   */
  #prepareWorkspace(task, snapshot) {
    const repoPath = task.repo_path;
    const wantWorktree = (this.config.git.isolation ?? "worktree") === "worktree";

    if (wantWorktree) {
      const created = createTaskWorktree({
        repoPath,
        worktreeRoot: this.paths.worktreeRoot,
        taskId: task.id,
        logger: this.logger,
      });
      if (created.ok) {
        // 再利用のときは、最初に作ったときの基準コミットを引き継ぐ。
        // 取り直すと、その間に本体へ入った他人のコミットまで
        // 「このタスクの変更」に見えてしまう（実測で誤検知 4 件が出た）。
        const baseCommit = created.reused && task.base_commit ? task.base_commit : created.baseCommit;
        const baseBranch = created.reused && task.base_branch ? task.base_branch : created.baseBranch;
        return {
          ok: true,
          isolation: "worktree",
          workDir: created.path,
          branch: created.branch,
          baseCommit,
          baseBranch,
          reused: created.reused,
        };
      }
      this.repo.audit("system", "workspace.worktree_failed", task.id, "error", created.reason);
      if (!this.config.git.allowInPlaceFallback) {
        return { ok: false, reason: `専用 worktree を作れませんでした: ${created.reason}` };
      }
      this.logger.warn("worktree を作れないため同一ツリーで作業します", {
        taskId: task.id,
        reason: created.reason,
      });
    }

    return {
      ok: true,
      isolation: "in-place",
      workDir: repoPath,
      branch: snapshot.branch,
      baseCommit: snapshot.headCommit,
      baseBranch: snapshot.branch,
    };
  }

  /**
   * 別セッションが同じファイルを触っていないか調べる。
   * 触っていれば自動マージせず、人に判断してもらう TODO を出す。
   */
  #checkCrossSessionConflicts(task, place, changedFiles) {
    if (!changedFiles?.length) return { conflicts: [] };

    const result = git.detectCrossSessionConflicts({
      repoPath: task.repo_path,
      baseCommit: place.baseCommit,
      taskFiles: changedFiles,
    });
    this.repo.checkpoint(task.id, "conflict_check", result);

    if (result.conflicts.length === 0) return result;

    this.logger.warn("別セッションが同じファイルを触っています。自動マージはしません。", {
      taskId: task.id,
      conflicts: result.conflicts,
    });
    this.repo.audit("system", "conflict.detected", task.id, `${result.conflicts.length} 件`, null);

    const list = result.conflicts.map((c) => `  ・${c.file}（${c.why}）`).join("\n");
    this.todoManager.createFromUserAction(
      {
        category: "approval",
        kind: "merge_conflict",
        title: `別セッションと同じファイルを変更しました: ${task.title}`,
        reason:
          "このタスクが変更したファイルを、本体リポジトリ側でも別のセッションまたはご本人が変更しています。\n" +
          "取り違えると片方の作業が消えるため、自動でのマージは行いません。\n\n" +
          `【重なっているファイル】\n${list}\n\n` +
          `【このタスクの成果】\n  ブランチ: ${place.branch}\n  作業場所: ${place.workDir}`,
        steps: [
          `差分を見る: git log --oneline ${place.baseBranch ?? "HEAD"}..${place.branch}`,
          `内容を見る: git diff ${place.baseCommit}..${place.branch}`,
          "どちらを採るか決めてから、手作業でマージする",
          "取り込まない場合は、このブランチを残したまま TODO を完了にしてよい",
        ],
        completionCondition: "マージするか、取り込まないと決めたこと",
        answerFormat: "text",
        answerRequired: true,
        canUseIPhone: false,
        estimatedMinutes: 15,
        priority: "urgent",
      },
      { waitingTaskIds: [task.id], source: "system" },
    );
    return result;
  }

  /**
   * タスク終了後の後始末。
   * 既定では worktree もブランチも残す（証拠として保持する）。
   * 設定で削除を有効にしても、安全確認を通ったときだけ消す。
   */
  cleanupWorkspace(taskId) {
    const task = this.repo.getTask(taskId);
    if (!task?.worktree_path) return { removed: false, reasons: ["worktree はありません"] };

    if (!this.config.git.removeWorktreeWhenSafe) {
      return { removed: false, reasons: ["設定により worktree は残します（証拠として保持）"] };
    }
    return removeWorktreeIfSafe({
      repoPath: task.repo_path,
      worktreePath: task.worktree_path,
      branch: task.worktree_branch,
      baseBranch: task.base_branch,
      logger: this.logger,
    });
  }

  /** worktree を消してよいかだけを調べる（消さない）。 */
  inspectWorkspace(taskId) {
    const task = this.repo.getTask(taskId);
    if (!task?.worktree_path) return { removable: false, reasons: ["worktree はありません"] };
    return canRemoveWorktree({
      repoPath: task.repo_path,
      worktreePath: task.worktree_path,
      branch: task.worktree_branch,
      baseBranch: task.base_branch,
    });
  }

  // --------------------------------------------------------- 審査の失敗
  /** 審査失敗を知らせていた TODO を閉じる。審査が通ったのに残っていると紛らわしい。 */
  #closeReviewFailureTodos(taskId) {
    for (const todo of this.repo.openTodosForTask(taskId, "review_failure")) {
      this.repo.store.run("UPDATE todos SET status='cancelled' WHERE id=? AND status='open'", [todo.id]);
      this.repo.audit("system", "todo.autoclose", todo.id, "審査が成功したため", null);
    }
  }

  /**
   * 審査ができなかったときの扱い (指示書 §7-4 / 追加要件)。
   *
   * 状態は awaiting_ai_review のまま保持する。ここで awaiting_user へ落とすと、
   * 利用上限が自然回復しても人が TODO を閉じるまで再開しなくなるため。
   * 「状態を保存する」= DB に残す、であって「人待ちにする」ではない。
   */
  #handleReviewFailure(task, err, provider) {
    const reason = err instanceof ReviewUnavailableError ? err.reason : REVIEW_FAILURE.TRANSIENT;
    const fresh = this.repo.getTask(task.id) ?? task;
    const failures = (fresh.review_failures ?? 0) + 1;
    const needsUser = NEEDS_USER_ACTION.includes(reason);

    // 利用上限は自然回復を待つので長め、認証切れと設定不足は人の操作後すぐ効くよう短め。
    const waitMs = needsUser
      ? reason === REVIEW_FAILURE.USAGE_LIMIT
        ? 15 * 60_000
        : REVIEW_RECHECK_MS
      : Math.min(
          (this.config.review.baseBackoffSeconds || 5) * 1000 * 2 ** Math.min(failures - 1, 6),
          (this.config.review.maxBackoffSeconds || 300) * 1000,
        ) || REVIEW_RECHECK_MS;

    this.repo.updateTask(task.id, {
      last_error: redactText(err.message).slice(0, 4000),
      review_failures: failures,
      retry_after: new Date(Date.now() + waitMs).toISOString(),
      blocked_reason: needsUser
        ? `審査を実行できません (${reason})。状態は保存してあります。`
        : `審査に失敗しました。${Math.round(waitMs / 1000)} 秒後に再試行します。`,
    });
    this.repo.checkpoint(task.id, "review_failure", { provider, reason, failures, message: redactText(err.message) });
    this.repo.audit("review_engine", "review.failed", task.id, reason, err.message);

    // 人の操作が要る失敗は初回から、そうでない失敗は繰り返してから TODO を出す。
    // 一時的な失敗のたびに人を呼ぶと TODO がノイズになる。
    const shouldNotify = needsUser || failures >= 3;
    if (shouldNotify) {
      const description = describeFailure(reason, { provider });
      this.todoManager.createFromUserAction(
        { ...description, kind: "review_failure" },
        { waitingTaskIds: [task.id], source: "review_engine" },
      );
    }

    this.logger[needsUser ? "warn" : "error"](
      needsUser ? "審査を実行できません。状態を保存して待機します。" : "審査に失敗しました。バックオフして再試行します。",
      {
        taskId: task.id,
        provider,
        reason,
        failures,
        retryInSeconds: Math.round(waitMs / 1000),
        error: err.message,
      },
    );
  }

  // --------------------------------------------------------- 手動審査の適用
  /**
   * 手動審査 TODO の回答を審査結果として取り込む。
   * TodoManager.complete() から呼ばれる。
   */
  applyManualReview(todo) {
    const taskId = (todo.waitingTaskIds ?? [])[0];
    const task = taskId ? this.repo.getTask(taskId) : null;
    if (!task) {
      this.logger.warn("手動審査の対象タスクが見つかりません", { todoId: todo.id });
      return null;
    }
    if (task.state !== STATES.AWAITING_AI_REVIEW) {
      this.logger.warn("手動審査の対象タスクが審査待ちではありません", { todoId: todo.id, state: task.state });
      return null;
    }

    const parsed = parseManualAnswer(todo.completed_answer);
    if (!parsed.decision) {
      this.logger.warn("手動審査の回答を解釈できませんでした", { todoId: todo.id });
      return null;
    }

    const checkpoint = this.repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase='evidence_gate' ORDER BY id DESC LIMIT 1",
      [task.id],
    );
    let evidence = null;
    try {
      evidence = checkpoint ? JSON.parse(checkpoint.data) : null;
    } catch {
      evidence = null;
    }

    const review = toReviewRecord(parsed, { evidence });
    const reviewId = this.repo.saveReview(task.id, task.report_id, review, {
      model: "human",
      promptVersion: "manual-v1",
      provider: "manual",
      usage: { answeredBy: "user", todoId: todo.id },
    });
    this.repo.updateTask(task.id, { retry_after: null, review_failures: 0 });
    this.repo.audit("user", "review.manual.applied", task.id, review.decision, null);

    // 手動でも「証拠ゲートが審査者より強い」規則は同じにする。
    // 人が「合格」と打っても、テスト未実行なら completed にはしない。
    const enforced = this.#enforceEvidenceGate(task, review, evidence);
    this.#applyDecision(task, enforced.decision, review, {
      reviewId,
      evidence,
      overrideReason: enforced.overrideReason,
    }).catch((err) => {
      this.logger.error("手動審査の適用中にエラー", { taskId: task.id, error: err.message });
    });

    return { decision: review.decision, reviewId, taskId: task.id };
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
