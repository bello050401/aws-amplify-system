/**
 * データアクセス層。状態遷移は必ず core/states.mjs の遷移表を通す。
 */
import crypto from "node:crypto";
import { STATES, TERMINAL_STATES, assertTransition } from "../core/states.mjs";
import { redactText, redactValue } from "../log/redact.mjs";

export const nowIso = () => new Date().toISOString();

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

/**
 * 冪等性キー。同じ指示文・同じ出所・同じ対象なら同じキーになる (§5-1)。
 * 明示キーが与えられた場合はそれを優先する。
 */
export function idempotencyKeyFor({ source, title, instruction, explicitKey, documentId }) {
  // 区切りには NUL を使う。件名や指示本文に現れない文字なので、
  // "a"+"bc" と "ab"+"c" が同じキーになる事故を防げる。
  // ソースへ生のバイトを書くと Git がバイナリ扱いして差分が読めなくなるため、
  // 必ずエスケープ表記で書くこと。
  if (explicitKey) return `explicit:${explicitKey}`;
  const h = crypto.createHash("sha256");
  h.update(String(source ?? ""));
  h.update("\u0000");
  h.update(String(documentId ?? ""));
  h.update("\u0000");
  h.update(String(title ?? "").trim());
  h.update("\u0000");
  h.update(String(instruction ?? "").trim());
  return `auto:${h.digest("hex")}`;
}

const jsonOrDefault = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

function hydrateTask(row) {
  if (!row) return null;
  return {
    ...row,
    dependsOn: jsonOrDefault(row.depends_on, []),
    changedFiles: jsonOrDefault(row.changed_files, []),
    todoIds: jsonOrDefault(row.todo_ids, []),
  };
}

function hydrateTodo(row) {
  if (!row) return null;
  return {
    ...row,
    steps: jsonOrDefault(row.steps, []),
    answerChoices: jsonOrDefault(row.answer_choices, []),
    waitingTaskIds: jsonOrDefault(row.waiting_task_ids, []),
    canUseIphone: !!row.can_use_iphone,
    answerRequired: !!row.answer_required,
  };
}

function hydrateDocument(row) {
  if (!row) return null;
  return { ...row, taskIds: jsonOrDefault(row.task_ids, []) };
}

export class Repo {
  constructor(store) {
    this.store = store;
  }

  // -------------------------------------------------------- 審査方式の選択
  /**
   * 実際に使う審査方式。ダッシュボードで切り替えた値を meta に持ち、
   * 未設定なら設定ファイルの既定値を使う。設定ファイルは Git 管理なので、
   * 運用中の切り替えでリポジトリを汚さないようにしている。
   */
  getReviewProvider(fallback) {
    const stored = this.store.getMeta("reviewProvider");
    return stored || fallback;
  }

  setReviewProvider(provider, actor = "user") {
    this.store.setMeta("reviewProvider", provider);
    this.audit(actor, "settings.reviewProvider", null, provider, null);
    return provider;
  }

  /**
   * 一時停止状態。メモリだけに持つと再起動で必ず解除されてしまい、
   * 「止めたはずのタスクが再起動で勝手に動き出す」ことになる。DB に持たせる。
   */
  getPaused() {
    return this.store.getMeta("paused") === "1";
  }

  setPaused(paused, actor = "user") {
    this.store.setMeta("paused", paused ? "1" : "0");
    this.audit(actor, paused ? "orchestrator.pause" : "orchestrator.resume", null, "ok", null);
    return paused;
  }

  // ---------------------------------------------------------------- audit
  audit(actor, action, target, result, detail) {
    this.store.run("INSERT INTO audit_log(at,actor,action,target,result,detail) VALUES(?,?,?,?,?,?)", [
      nowIso(),
      actor,
      action,
      target ?? null,
      result ?? null,
      detail == null ? null : redactText(typeof detail === "string" ? detail : JSON.stringify(redactValue(detail))),
    ]);
  }

  listAudit(limit = 200) {
    return this.store.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
  }

  // ---------------------------------------------------------------- tasks
  /**
   * タスク登録。冪等性キーが既存なら新規作成せず既存を返す (§14-1)。
   * 戻り値 { task, created }。
   */
  createTask(input) {
    const key = idempotencyKeyFor(input);
    const existing = this.store.get("SELECT * FROM tasks WHERE idempotency_key=?", [key]);
    if (existing) return { task: hydrateTask(existing), created: false };

    const id = newId("task");
    const at = nowIso();
    const task = {
      id,
      title: String(input.title ?? "").slice(0, 500) || "(無題のタスク)",
      instruction: String(input.instruction ?? ""),
      source: input.source ?? "user_ui",
      priority: Number.isInteger(input.priority) ? input.priority : 50,
      state: STATES.QUEUED,
      created_at: at,
      updated_at: at,
      repo_path: input.repoPath,
      branch: input.branch ?? null,
      work_dir: input.workDir ?? null,
      depends_on: JSON.stringify(input.dependsOn ?? []),
      max_attempts: input.maxAttempts ?? 3,
      max_revisions: input.maxRevisions ?? 3,
      idempotency_key: key,
      document_id: input.documentId ?? null,
    };

    this.store.run(
      `INSERT INTO tasks(id,title,instruction,source,priority,state,created_at,updated_at,
         repo_path,branch,work_dir,depends_on,max_attempts,max_revisions,idempotency_key,document_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        task.id,
        task.title,
        task.instruction,
        task.source,
        task.priority,
        task.state,
        task.created_at,
        task.updated_at,
        task.repo_path,
        task.branch,
        task.work_dir,
        task.depends_on,
        task.max_attempts,
        task.max_revisions,
        task.idempotency_key,
        task.document_id,
      ],
    );
    this.store.run("INSERT INTO task_state_history(task_id,from_state,to_state,reason,actor,at) VALUES(?,?,?,?,?,?)", [
      id,
      null,
      STATES.QUEUED,
      "created",
      input.source ?? "user_ui",
      at,
    ]);
    this.audit(input.source ?? "user_ui", "task.create", id, "ok", task.title);
    return { task: this.getTask(id), created: true };
  }

  getTask(id) {
    return hydrateTask(this.store.get("SELECT * FROM tasks WHERE id=?", [id]));
  }

  listTasks({ state = null, limit = 200 } = {}) {
    const rows = state
      ? this.store.all("SELECT * FROM tasks WHERE state=? ORDER BY priority DESC, created_at ASC LIMIT ?", [state, limit])
      : this.store.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", [limit]);
    return rows.map(hydrateTask);
  }

  countByState() {
    const rows = this.store.all("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state");
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /**
   * 次に実行すべきタスクを 1 件返す。依存が未解決のものは選ばない。
   * 並び順は決定的 (優先度降順 → 作成順)。§9-4「複数文書は決定的に並べる」。
   */
  claimNextTask() {
    const candidates = this.store.all(
      "SELECT * FROM tasks WHERE state=? ORDER BY priority DESC, created_at ASC",
      [STATES.QUEUED],
    );
    for (const row of candidates) {
      const task = hydrateTask(row);
      const unmet = this.unmetDependencies(task);
      if (unmet.length === 0) return task;
    }
    return null;
  }

  unmetDependencies(task) {
    const unmet = [];
    for (const depId of task.dependsOn ?? []) {
      const dep = this.getTask(depId);
      if (!dep || dep.state !== STATES.COMPLETED) unmet.push(depId);
    }
    return unmet;
  }

  /**
   * 審査待ちのうち、いま審査してよいものを 1 件返す。
   *
   * retry_after を見るのが肝心。API キーが無い / API が落ちている間、
   * 審査待ちタスクを毎 tick 掴んでしまうと、ループが一切眠らずに回り続け
   * (実測で毎秒 8 回)、ログが溢れてダッシュボードまで応答しなくなる。
   */
  claimNextReview() {
    // 手動審査の判定待ち (open な manual_review TODO がある) タスクは掴まない。
    // 掴むと毎 tick 同じ依頼を作り直してしまう。TODO を完了 / 取消すれば再び対象になる。
    const row = this.store.get(
      `SELECT t.* FROM tasks t
        WHERE t.state=? AND (t.retry_after IS NULL OR t.retry_after<=?)
          AND NOT EXISTS (
            SELECT 1 FROM todos d
             WHERE d.status='open' AND d.kind='manual_review'
               AND d.waiting_task_ids LIKE '%' || t.id || '%'
          )
        ORDER BY t.priority DESC, t.updated_at ASC LIMIT 1`,
      [STATES.AWAITING_AI_REVIEW, nowIso()],
    );
    return hydrateTask(row);
  }

  /** あるタスクに紐づく、指定種別の open な TODO。 */
  openTodosForTask(taskId, kind = null) {
    return this.listTodos({ status: "open" }).filter(
      (t) => t.waitingTaskIds.includes(taskId) && (kind === null || t.kind === kind),
    );
  }

  /** 再試行待ちのうち、待機時間が過ぎたものを queued へ戻す。 */
  releaseDueRetries(actor = "system") {
    const due = this.store.all("SELECT * FROM tasks WHERE state=? AND (retry_after IS NULL OR retry_after<=?)", [
      STATES.RETRY_WAIT,
      nowIso(),
    ]);
    for (const row of due) {
      this.setState(row.id, STATES.QUEUED, "retry backoff elapsed", actor);
    }
    return due.length;
  }

  setState(taskId, toState, reason, actor = "system", extra = {}) {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`タスクが見つかりません: ${taskId}`);
    assertTransition(current.state, toState);

    const at = nowIso();
    const sets = ["state=?", "updated_at=?"];
    const params = [toState, at];

    if (toState === STATES.RUNNING && !current.started_at) {
      sets.push("started_at=?");
      params.push(at);
    }
    if (TERMINAL_STATES.includes(toState)) {
      sets.push("finished_at=?");
      params.push(at);
    }
    for (const [column, value] of Object.entries(extra)) {
      sets.push(`${column}=?`);
      params.push(value);
    }
    params.push(taskId);

    this.store.run(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`, params);
    this.store.run("INSERT INTO task_state_history(task_id,from_state,to_state,reason,actor,at) VALUES(?,?,?,?,?,?)", [
      taskId,
      current.state,
      toState,
      reason ? redactText(String(reason)).slice(0, 2000) : null,
      actor,
      at,
    ]);
    this.audit(actor, "task.state", taskId, `${current.state}->${toState}`, reason);
    return this.getTask(taskId);
  }

  updateTask(taskId, fields) {
    const sets = ["updated_at=?"];
    const params = [nowIso()];
    for (const [column, value] of Object.entries(fields)) {
      sets.push(`${column}=?`);
      params.push(value);
    }
    params.push(taskId);
    this.store.run(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`, params);
    return this.getTask(taskId);
  }

  touchHeartbeat(taskId) {
    this.store.run("UPDATE tasks SET heartbeat_at=?, updated_at=? WHERE id=?", [nowIso(), nowIso(), taskId]);
  }

  history(taskId) {
    return this.store.all("SELECT * FROM task_state_history WHERE task_id=? ORDER BY id ASC", [taskId]);
  }

  // ----------------------------------------------------------- checkpoints
  checkpoint(taskId, phase, data = {}) {
    this.store.run("INSERT INTO checkpoints(task_id,phase,data,at) VALUES(?,?,?,?)", [
      taskId,
      phase,
      JSON.stringify(redactValue(data)),
      nowIso(),
    ]);
  }

  latestCheckpoint(taskId) {
    return this.store.get("SELECT * FROM checkpoints WHERE task_id=? ORDER BY id DESC LIMIT 1", [taskId]);
  }

  // --------------------------------------------------------------- reports
  saveReport(taskId, attempt, report, rawValid = true) {
    const id = newId("rep");
    const safe = redactValue(report);
    this.store.run("INSERT INTO reports(id,task_id,attempt,status,json,raw_valid,created_at) VALUES(?,?,?,?,?,?,?)", [
      id,
      taskId,
      attempt,
      String(report?.status ?? "failed"),
      JSON.stringify(safe),
      rawValid ? 1 : 0,
      nowIso(),
    ]);
    this.store.run("UPDATE tasks SET report_id=?, updated_at=? WHERE id=?", [id, nowIso(), taskId]);
    return id;
  }

  getReport(id) {
    const row = this.store.get("SELECT * FROM reports WHERE id=?", [id]);
    return row ? { ...row, report: jsonOrDefault(row.json, {}) } : null;
  }

  // --------------------------------------------------------------- reviews
  saveReview(taskId, reportId, review, meta = {}) {
    const id = newId("rev");
    this.store.run(
      `INSERT INTO reviews(id,task_id,report_id,decision,confidence,json,model,prompt_version,usage,provider,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        taskId,
        reportId ?? null,
        String(review?.decision ?? "fail_safely"),
        Number.isFinite(review?.confidence) ? review.confidence : null,
        JSON.stringify(redactValue(review)),
        meta.model ?? null,
        meta.promptVersion ?? null,
        meta.usage ? JSON.stringify(redactValue(meta.usage)) : null,
        meta.provider ?? "openai",
        nowIso(),
      ],
    );
    this.store.run("UPDATE tasks SET review_id=?, updated_at=? WHERE id=?", [id, nowIso(), taskId]);
    return id;
  }

  getReview(id) {
    const row = this.store.get("SELECT * FROM reviews WHERE id=?", [id]);
    return row ? { ...row, review: jsonOrDefault(row.json, {}) } : null;
  }

  reviewsFor(taskId) {
    return this.store
      .all("SELECT * FROM reviews WHERE task_id=? ORDER BY created_at ASC", [taskId])
      .map((r) => ({ ...r, review: jsonOrDefault(r.json, {}) }));
  }

  // ----------------------------------------------------------------- todos
  /**
   * TODO 作成。dedupe_key が同じ open の TODO が既にあれば新規作成しない
   * (§8-3「既に満たされている項目を繰り返し要求しない」)。
   */
  createTodo(input) {
    const dedupeKey =
      input.dedupeKey ??
      crypto.createHash("sha256").update(`${input.category}\u0000${input.title}`).digest("hex").slice(0, 32);

    const existing = this.store.get("SELECT * FROM todos WHERE dedupe_key=? AND status='open'", [dedupeKey]);
    if (existing) {
      // 待ちタスクだけ足しておく。同じ依頼を二重に出さない。
      const waiting = new Set(jsonOrDefault(existing.waiting_task_ids, []));
      let changed = false;
      for (const t of input.waitingTaskIds ?? []) {
        if (!waiting.has(t)) {
          waiting.add(t);
          changed = true;
        }
      }
      if (changed) {
        this.store.run("UPDATE todos SET waiting_task_ids=? WHERE id=?", [
          JSON.stringify([...waiting]),
          existing.id,
        ]);
      }
      return { todo: hydrateTodo(this.store.get("SELECT * FROM todos WHERE id=?", [existing.id])), created: false };
    }

    const id = newId("todo");
    this.store.run(
      `INSERT INTO todos(id,category,title,action_required,reason,can_use_iphone,target_url,steps,
         estimated_minutes,priority,due_at,completion_condition,answer_format,answer_choices,answer_required,
         waiting_task_ids,status,created_at,dedupe_key,kind)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.category ?? "other",
        String(input.title ?? "").slice(0, 300),
        String(input.actionRequired ?? ""),
        String(input.reason ?? ""),
        input.canUseIphone ? 1 : 0,
        // 秘密付き URL は保存しない (§5-3)
        input.targetUrl ? redactText(String(input.targetUrl)) : null,
        JSON.stringify(input.steps ?? []),
        Number.isInteger(input.estimatedMinutes) ? input.estimatedMinutes : null,
        input.priority === "urgent" ? "urgent" : "normal",
        input.dueAt ?? null,
        String(input.completionCondition ?? ""),
        input.answerFormat ?? "checkbox",
        JSON.stringify(input.answerChoices ?? []),
        input.answerRequired ? 1 : 0,
        JSON.stringify(input.waitingTaskIds ?? []),
        "open",
        nowIso(),
        dedupeKey,
        input.kind ?? "action",
      ],
    );
    this.audit("system", "todo.create", id, "ok", input.title);
    return { todo: this.getTodo(id), created: true };
  }

  getTodo(id) {
    return hydrateTodo(this.store.get("SELECT * FROM todos WHERE id=?", [id]));
  }

  listTodos({ status = null } = {}) {
    const rows = status
      ? this.store.all("SELECT * FROM todos WHERE status=? ORDER BY (priority='urgent') DESC, created_at ASC", [status])
      : this.store.all("SELECT * FROM todos ORDER BY (status='open') DESC, created_at DESC");
    return rows.map(hydrateTodo);
  }

  getDocument(id) {
    return hydrateDocument(this.store.get("SELECT * FROM documents WHERE id=?", [id]));
  }

  findDocumentBySha(sha256) {
    return hydrateDocument(this.store.get("SELECT * FROM documents WHERE sha256=?", [sha256]));
  }

  listDocuments(limit = 100) {
    return this.store.all("SELECT * FROM documents ORDER BY received_at DESC LIMIT ?", [limit]).map(hydrateDocument);
  }

  createDocument(input) {
    const id = newId("doc");
    this.store.run(
      `INSERT INTO documents(id,original_name,sha256,received_at,byte_size,parse_state,stored_path)
       VALUES(?,?,?,?,?,?,?)`,
      [id, input.originalName, input.sha256, nowIso(), input.byteSize, input.parseState ?? "received", input.storedPath ?? null],
    );
    this.audit("system", "document.create", id, "ok", input.originalName);
    return this.getDocument(id);
  }

  updateDocument(id, fields) {
    const sets = [];
    const params = [];
    for (const [column, value] of Object.entries(fields)) {
      sets.push(`${column}=?`);
      params.push(value);
    }
    if (sets.length === 0) return this.getDocument(id);
    params.push(id);
    this.store.run(`UPDATE documents SET ${sets.join(",")} WHERE id=?`, params);
    return this.getDocument(id);
  }

  // ---------------------------------------------------------- idempotency
  /**
   * 同じ外部操作を二重実行しない (§6-3-7)。
   * 既に記録があれば false を返し、無ければ記録して true を返す。
   */
  claimIdempotency(key, scope, result = null) {
    const existing = this.store.get("SELECT key FROM idempotency WHERE key=?", [key]);
    if (existing) return false;
    this.store.run("INSERT INTO idempotency(key,scope,result,created_at) VALUES(?,?,?,?)", [
      key,
      scope,
      result == null ? null : String(result),
      nowIso(),
    ]);
    return true;
  }
}
