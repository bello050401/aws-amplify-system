/**
 * User TODO Manager (指示書 §8)。
 *
 * 本人にしかできない操作だけをここへ分離する。完了はサーバ側で検証し、
 * 依存タスクの再開は「一度だけ」行う。
 */
import crypto from "node:crypto";
import { STATES } from "../core/states.mjs";

const CATEGORIES = new Set([
  "auth",
  "mfa",
  "oauth",
  "visual_review",
  "approval",
  "paid_action",
  "destructive_action",
  "specification_decision",
  "other",
]);

export class TodoValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TodoValidationError";
  }
}

export class TodoManager {
  constructor({ repo, logger }) {
    this.repo = repo;
    this.logger = logger;
  }

  /**
   * Claude / 審査エンジンが報告した userActions を TODO に変換する。
   * 同じ依頼を繰り返し出さないよう dedupeKey を安定させる。
   */
  createFromUserAction(action, { waitingTaskIds = [], source = "system" } = {}) {
    const category = CATEGORIES.has(action.category) ? action.category : "other";
    const dedupeKey = crypto
      .createHash("sha256")
      .update(
        [
          category,
          action.kind ?? "action",
          String(action.title ?? "").trim(),
          String(action.completionCondition ?? "").trim(),
          // 手動審査はタスクごとに別の依頼なので、まとめてはいけない
          action.kind === "manual_review" ? waitingTaskIds.join(",") : "",
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 32);

    // 認証・承認・仕様判断は「チェックだけ」で終わらせない (§5-3 末尾)
    const needsAnswer = ["specification_decision", "approval", "visual_review"].includes(category);

    const { todo, created } = this.repo.createTodo({
      category,
      title: action.title ?? "(件名なし)",
      actionRequired: Array.isArray(action.steps) && action.steps.length ? action.steps.join("\n") : (action.actionRequired ?? action.reason ?? ""),
      reason: action.reason ?? "",
      canUseIphone: action.canUseIPhone ?? action.canUseIphone ?? false,
      targetUrl: action.targetUrl ?? null,
      steps: action.steps ?? [],
      estimatedMinutes: Number.isInteger(action.estimatedMinutes) ? action.estimatedMinutes : null,
      priority: action.priority === "urgent" ? "urgent" : "normal",
      completionCondition: action.completionCondition ?? "",
      answerFormat: action.answerFormat ?? (needsAnswer ? "text" : "checkbox"),
      answerChoices: action.answerChoices ?? [],
      answerRequired: action.answerRequired ?? needsAnswer,
      waitingTaskIds,
      dedupeKey,
      kind: action.kind ?? "action",
    });

    if (created) this.logger?.info?.("ユーザー TODO を作成しました", { todoId: todo.id, title: todo.title, source });
    return { todo, created };
  }

  openTodos() {
    return this.repo.listTodos({ status: "open" });
  }

  /**
   * TODO 完了。必須回答が空なら完了させない (§8-2)。
   * 依存解除は resume_dispatched により一度しか起きない。
   */
  complete(todoId, { answer = null, attachmentPath = null, actor = "user" } = {}) {
    const todo = this.repo.getTodo(todoId);
    if (!todo) throw new TodoValidationError(`TODO が見つかりません: ${todoId}`);
    if (todo.status === "completed") {
      return { todo, resumedTaskIds: [], alreadyCompleted: true };
    }
    if (todo.status !== "open") {
      throw new TodoValidationError(`この TODO は ${todo.status} のため完了できません。`);
    }

    if (todo.answerRequired) {
      const text = typeof answer === "string" ? answer.trim() : "";
      if (!text && !attachmentPath) {
        throw new TodoValidationError("この TODO は回答が必須です。内容を入力してください。");
      }
      if (todo.answer_format === "choice" && todo.answerChoices.length > 0 && !todo.answerChoices.includes(text)) {
        throw new TodoValidationError(`回答は次のいずれかにしてください: ${todo.answerChoices.join(" / ")}`);
      }
    }
    if ((todo.answer_format === "file" || todo.answer_format === "screenshot") && !attachmentPath) {
      throw new TodoValidationError("この TODO はファイル / スクリーンショットの添付が必要です。");
    }

    const resumed = [];
    let manualReviewTodo = null;
    this.repo.store.transaction(() => {
      this.repo.store.run(
        "UPDATE todos SET status='completed', completed_at=?, completed_answer=?, attachment_path=? WHERE id=? AND status='open'",
        [new Date().toISOString(), answer == null ? null : String(answer), attachmentPath, todoId],
      );
      this.repo.audit(actor, "todo.complete", todoId, "ok", todo.title);

      // 依存解除を一度だけ行う
      const fresh = this.repo.getTodo(todoId);
      if (fresh.resume_dispatched === 0) {
        this.repo.store.run("UPDATE todos SET resume_dispatched=1 WHERE id=?", [todoId]);

        // 手動審査の判定は「依存解除」ではなく「審査結果」として扱う。
        // ここで queued へ戻すと審査を飛ばして再実行になってしまう。
        if (fresh.kind === "manual_review") {
          manualReviewTodo = fresh;
          return;
        }

        for (const taskId of fresh.waitingTaskIds) {
          const task = this.repo.getTask(taskId);
          if (!task || task.state !== STATES.AWAITING_USER) continue;
          if (this.#allBlockingTodosClosed(taskId)) {
            this.repo.setState(taskId, STATES.QUEUED, `TODO 完了により再開 (${todoId})`, actor, {
              blocked_reason: null,
            });
            resumed.push(taskId);
          }
        }
      }
    });

    // トランザクションの外で呼ぶ。審査結果の適用は状態遷移と監査ログを伴い、
    // 失敗しても「TODO は完了した」事実は残すべきだから。
    let manualReview = null;
    if (manualReviewTodo && typeof this.onManualReview === "function") {
      try {
        manualReview = this.onManualReview(manualReviewTodo);
      } catch (err) {
        this.logger?.error?.("手動審査の適用に失敗しました", { todoId, error: err.message });
        this.repo.audit("user", "review.manual.failed", todoId, "error", err.message);
      }
    }

    this.logger?.info?.("TODO を完了しました", { todoId, resumedTaskIds: resumed, manualReview: manualReview?.decision ?? null });
    return {
      todo: this.repo.getTodo(todoId),
      resumedTaskIds: resumed,
      alreadyCompleted: false,
      manualReview,
    };
  }

  /** 待機中の TODO が他にも残っていないか確認する (§8-2「すべて解除された時だけ」)。 */
  #allBlockingTodosClosed(taskId) {
    const open = this.repo.listTodos({ status: "open" });
    return !open.some((t) => t.waitingTaskIds.includes(taskId));
  }

  /**
   * もう当てはまらない環境 TODO を閉じる。
   *
   * 審査方式を Claude / 手動へ戻したのに「OpenAI キーを設定してください」が
   * 残り続けると、要らない作業を延々と要求することになる。
   */
  closeObsoleteEnvironmentTodos(env = process.env) {
    const closed = [];
    const stillNeeded = Boolean(this.requireOpenAiKey) && !env.OPENAI_API_KEY;
    if (stillNeeded) return closed;

    for (const todo of this.repo.listTodos({ status: "open" })) {
      // kind が付く前に作られた古い TODO も件名で拾う
      const isOpenAiKeyTodo = todo.kind === "openai_key" || todo.title.includes("OpenAI API キーを設定する");
      if (!isOpenAiKeyTodo) continue;
      this.repo.store.run("UPDATE todos SET status='cancelled' WHERE id=? AND status='open'", [todo.id]);
      this.repo.audit("system", "todo.autoclose", todo.id, "この審査方式では不要になったため", null);
      closed.push(todo.id);
    }
    if (closed.length) {
      this.logger?.info?.("不要になった環境 TODO を閉じました", { count: closed.length });
    }
    return closed;
  }

  cancel(todoId, actor = "user") {
    const todo = this.repo.getTodo(todoId);
    if (!todo) throw new TodoValidationError(`TODO が見つかりません: ${todoId}`);
    this.repo.store.run("UPDATE todos SET status='cancelled' WHERE id=? AND status='open'", [todoId]);
    this.repo.audit(actor, "todo.cancel", todoId, "ok", todo.title);
    return this.repo.getTodo(todoId);
  }

  /**
   * 環境の不足に応じた初期 TODO (§8-3)。
   * 既に満たされている項目は作らない。
   *
   * **OPENAI_API_KEY が無いことは不足ではない。** 既定の審査方式は追加課金の要らない
   * Claude 審査であり、OpenAI は任意のオプションだから。ここで TODO を作ると、
   * 使う予定のない設定を延々と要求することになる。
   */
  ensureEnvironmentTodos(env = process.env) {
    const created = [];
    // 将来 OpenAI を明示的に選び、かつキーが無い場合だけ知らせる。
    // 既定 (claude / manual) では何も作らない。
    if (this.requireOpenAiKey && !env.OPENAI_API_KEY) {
      const { todo, created: made } = this.createFromUserAction(
        {
          category: "auth",
          title: "OpenAI API キーを設定する（AI 審査を有効にするため）",
          reason:
            "OPENAI_API_KEY が未設定のため、Claude の完了報告を自動審査できません。設定するまで完了報告は awaiting_ai_review で停止します。開発タスクの実行自体は継続します。",
          steps: [
            "OpenAI のダッシュボードで API キーを作成する",
            "Windows のユーザー環境変数 OPENAI_API_KEY にその値を設定する（PowerShell: [Environment]::SetEnvironmentVariable('OPENAI_API_KEY','<キー>','User')）",
            "Orchestrator を再起動する（bello.ps1 restart）",
          ],
          kind: "openai_key",
          completionCondition:
            "bello.ps1 diagnose の出力で「OpenAI 連携 設定済み」と表示されること。キーの値はどこにも貼らないでください。",
          canUseIPhone: false,
          estimatedMinutes: 10,
          priority: "normal",
        },
        { source: "environment" },
      );
      if (made) created.push(todo);
    }
    return created;
  }
}
