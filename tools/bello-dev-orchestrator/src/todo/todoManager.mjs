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
      .update(`${category}|${String(action.title ?? "").trim()}|${String(action.completionCondition ?? "").trim()}`)
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

    this.logger?.info?.("TODO を完了しました", { todoId, resumedTaskIds: resumed });
    return { todo: this.repo.getTodo(todoId), resumedTaskIds: resumed, alreadyCompleted: false };
  }

  /** 待機中の TODO が他にも残っていないか確認する (§8-2「すべて解除された時だけ」)。 */
  #allBlockingTodosClosed(taskId) {
    const open = this.repo.listTodos({ status: "open" });
    return !open.some((t) => t.waitingTaskIds.includes(taskId));
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
   */
  ensureEnvironmentTodos(env = process.env) {
    const created = [];
    if (!env.OPENAI_API_KEY) {
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
          completionCondition:
            "bello.ps1 diagnose の出力で「OpenAI: 設定済み」と表示されること。キーの値はどこにも貼らないでください。",
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
