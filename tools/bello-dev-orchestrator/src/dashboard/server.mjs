/**
 * ローカルダッシュボード (指示書 §10)。
 *
 * node:http のみ。既定は 127.0.0.1 限定。LAN 公開は明示設定 + 共有トークン必須。
 * - CSRF: 状態変更は POST のみ、Origin/Host 一致と X-BELLO-Request ヘッダを必須にする
 * - XSS: サーバは HTML を組み立てない。画面側は textContent でのみ描画する
 * - パストラバーサル: 静的配信は許可リストのファイル名のみ
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { STATE_LABELS_JA, STATES } from "../core/states.mjs";
import { redactValue } from "../log/redact.mjs";
import { safeFileName } from "../intake/documentIntake.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);

const MAX_JSON_BODY = 1 * 1024 * 1024;

export class Dashboard {
  constructor({ config, paths, repo, logger, orchestrator, todoManager, intake, diagnostics }) {
    this.config = config;
    this.paths = paths;
    this.repo = repo;
    this.logger = logger;
    this.orchestrator = orchestrator;
    this.todoManager = todoManager;
    this.intake = intake;
    this.diagnostics = diagnostics;
    this.server = null;
    this.startedAt = new Date().toISOString();
  }

  get requiredToken() {
    if (!this.config.dashboard.lanAccess) return null;
    return process.env[this.config.dashboard.lanAccessTokenEnvVar] || null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.#handle(req, res).catch((err) => {
          this.logger.error("ダッシュボードで未処理の例外", { error: err.message });
          this.#json(res, 500, { error: "内部エラーが発生しました。" });
        });
      });
      this.server.on("error", reject);
      this.server.listen(this.config.dashboard.port, this.config.dashboard.host, () => {
        this.logger.info("ダッシュボードを起動しました", {
          url: `http://${this.config.dashboard.host}:${this.config.dashboard.port}/`,
          lanAccess: this.config.dashboard.lanAccess,
        });
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  // ------------------------------------------------------------- handling
  async #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname;

    if (this.requiredToken) {
      const provided = req.headers["x-bello-token"] || url.searchParams.get("token") || "";
      const expected = this.requiredToken;
      const ok =
        provided.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(String(provided)), Buffer.from(expected));
      if (!ok) return this.#json(res, 401, { error: "認証トークンが必要です。" });
    }

    if (req.method === "GET" && STATIC_FILES.has(route)) return this.#serveStatic(res, route);
    if (!route.startsWith("/api/")) return this.#json(res, 404, { error: "見つかりません" });

    if (req.method !== "GET") {
      // CSRF 対策: 単純なフォーム POST では付けられないヘッダを必須にする
      if (req.headers["x-bello-request"] !== "1") {
        return this.#json(res, 403, { error: "不正なリクエストです (X-BELLO-Request が必要)。" });
      }
      const origin = req.headers.origin;
      if (origin) {
        const expectedHost = req.headers.host;
        try {
          if (new URL(origin).host !== expectedHost) {
            return this.#json(res, 403, { error: "オリジンが一致しません。" });
          }
        } catch {
          return this.#json(res, 403, { error: "オリジンが不正です。" });
        }
      }
    }

    try {
      return await this.#route(req, res, route, url);
    } catch (err) {
      return this.#json(res, 400, { error: String(err.message ?? err) });
    }
  }

  async #route(req, res, route, url) {
    // ---- 読み取り ------------------------------------------------------
    if (req.method === "GET") {
      switch (route) {
        case "/api/home":
          return this.#json(res, 200, this.#home());
        case "/api/tasks":
          return this.#json(res, 200, { tasks: this.repo.listTasks({ limit: 300 }).map(publicTask) });
        case "/api/todos":
          return this.#json(res, 200, { todos: this.repo.listTodos().map(publicTodo) });
        case "/api/documents":
          return this.#json(res, 200, { documents: this.repo.listDocuments(100).map(publicDocument) });
        case "/api/audit":
          return this.#json(res, 200, { entries: this.repo.listAudit(300) });
        case "/api/system":
          return this.#json(res, 200, await this.diagnostics.report());
        case "/api/settings":
          return this.#json(res, 200, { config: publicConfig(this.config), paths: this.paths });
        default:
          break;
      }
      const taskMatch = /^\/api\/tasks\/([A-Za-z0-9_]+)$/.exec(route);
      if (taskMatch) return this.#json(res, 200, this.#taskDetail(taskMatch[1]));
      const docMatch = /^\/api\/documents\/([A-Za-z0-9_]+)$/.exec(route);
      if (docMatch) {
        const doc = this.repo.getDocument(docMatch[1]);
        if (!doc) return this.#json(res, 404, { error: "文書が見つかりません" });
        return this.#json(res, 200, { document: publicDocument(doc), text: doc.extracted_text ?? "" });
      }
      return this.#json(res, 404, { error: "見つかりません" });
    }

    // ---- 書き込み ------------------------------------------------------
    if (req.method === "POST") {
      if (route === "/api/documents/upload") return this.#upload(req, res, url);

      const body = await this.#readJson(req);

      switch (route) {
        case "/api/control/pause":
          this.orchestrator.pause();
          return this.#json(res, 200, { paused: true });
        case "/api/control/resume":
          this.orchestrator.resume();
          return this.#json(res, 200, { paused: false });
        case "/api/control/stop-current":
          this.orchestrator.requestStopCurrent();
          return this.#json(res, 200, { requested: true });
        case "/api/control/diagnose":
          return this.#json(res, 200, await this.diagnostics.report());
        case "/api/tasks": {
          if (!body.title || !body.instruction) throw new Error("title と instruction は必須です。");
          const { task, created } = this.repo.createTask({
            title: String(body.title),
            instruction: String(body.instruction),
            source: "user_ui",
            priority: Number.isInteger(body.priority) ? body.priority : 50,
            repoPath: this.config.repoPath,
            dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : [],
            maxAttempts: this.config.queue.maxAttempts,
            maxRevisions: this.config.review.maxRevisions,
          });
          return this.#json(res, created ? 201 : 200, { task: publicTask(task), created });
        }
        default:
          break;
      }

      let m;
      if ((m = /^\/api\/tasks\/([A-Za-z0-9_]+)\/cancel$/.exec(route))) {
        const task = this.repo.setState(m[1], STATES.CANCELLED, body.reason ?? "ユーザー操作", "user", {
          cancel_reason: String(body.reason ?? "ユーザー操作"),
        });
        return this.#json(res, 200, { task: publicTask(task) });
      }
      if ((m = /^\/api\/tasks\/([A-Za-z0-9_]+)\/retry$/.exec(route))) {
        const task = this.repo.setState(m[1], STATES.QUEUED, "ユーザーによる再試行", "user", {
          attempts: 0,
          last_error: null,
          last_failure_signature: null,
          blocked_reason: null,
        });
        return this.#json(res, 200, { task: publicTask(task) });
      }
      if ((m = /^\/api\/tasks\/([A-Za-z0-9_]+)\/priority$/.exec(route))) {
        const priority = Number(body.priority);
        if (!Number.isInteger(priority)) throw new Error("priority は整数で指定してください。");
        const task = this.repo.updateTask(m[1], { priority });
        this.repo.audit("user", "task.priority", m[1], String(priority), null);
        return this.#json(res, 200, { task: publicTask(task) });
      }
      if ((m = /^\/api\/todos\/([A-Za-z0-9_]+)\/complete$/.exec(route))) {
        const result = this.todoManager.complete(m[1], {
          answer: body.answer ?? null,
          attachmentPath: body.attachmentPath ?? null,
          actor: "user",
        });
        return this.#json(res, 200, {
          todo: publicTodo(result.todo),
          resumedTaskIds: result.resumedTaskIds,
          alreadyCompleted: result.alreadyCompleted,
        });
      }
      if ((m = /^\/api\/todos\/([A-Za-z0-9_]+)\/cancel$/.exec(route))) {
        return this.#json(res, 200, { todo: publicTodo(this.todoManager.cancel(m[1])) });
      }
      if ((m = /^\/api\/documents\/([A-Za-z0-9_]+)\/convert$/.exec(route))) {
        const { task, created } = this.intake.convertToTask(m[1], {
          priority: Number.isInteger(body.priority) ? body.priority : 40,
        });
        return this.#json(res, 200, { task: publicTask(task), created });
      }
      return this.#json(res, 404, { error: "見つかりません" });
    }

    return this.#json(res, 405, { error: "許可されていないメソッドです" });
  }

  // ------------------------------------------------------------ payloads
  #home() {
    const counts = this.repo.countByState();
    const openTodos = this.repo.listTodos({ status: "open" }).map(publicTodo);
    const current = this.orchestrator.currentTaskId ? this.repo.getTask(this.orchestrator.currentTaskId) : null;
    const nextTask = this.repo.claimNextTask();
    return {
      now: new Date().toISOString(),
      timezone: this.config.timezone,
      startedAt: this.startedAt,
      paused: this.orchestrator.paused,
      counts,
      stateLabels: STATE_LABELS_JA,
      currentTask: current ? publicTask(current) : null,
      nextTask: nextTask ? publicTask(nextTask) : null,
      openTodoCount: openTodos.length,
      urgentTodoCount: openTodos.filter((t) => t.priority === "urgent").length,
      openTodos,
      lastHeartbeat: current?.heartbeat_at ?? null,
      reviewConfigured: this.diagnostics.isReviewConfigured(),
    };
  }

  #taskDetail(taskId) {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error("タスクが見つかりません");
    const report = task.report_id ? this.repo.getReport(task.report_id) : null;
    return {
      task: publicTask(task),
      instruction: task.instruction,
      report: report?.report ?? null,
      reviews: this.repo.reviewsFor(taskId).map((r) => ({
        id: r.id,
        decision: r.decision,
        confidence: r.confidence,
        model: r.model,
        createdAt: r.created_at,
        review: r.review,
      })),
      history: this.repo.history(taskId),
      checkpoint: this.repo.latestCheckpoint(taskId),
    };
  }

  // ------------------------------------------------------------- helpers
  async #upload(req, res, url) {
    const rawName = url.searchParams.get("filename") ?? "upload.docx";
    const name = safeFileName(rawName);
    if (!/\.docx$/i.test(name)) throw new Error(".docx ファイルのみアップロードできます。");

    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > this.config.intake.maxFileBytes) {
        throw new Error(`ファイルサイズが上限 (${this.config.intake.maxFileBytes} bytes) を超えています。`);
      }
      chunks.push(chunk);
    }
    if (total === 0) throw new Error("ファイルが空です。");

    fs.mkdirSync(this.paths.uploadsDir, { recursive: true });
    const tempPath = path.join(this.paths.uploadsDir, `${Date.now()}-${name}`);
    fs.writeFileSync(tempPath, Buffer.concat(chunks));

    await this.intake.ingestFile(tempPath, name);
    const doc = this.repo.listDocuments(1)[0];
    return this.#json(res, 200, { ok: true, document: doc ? publicDocument(doc) : null });
  }

  async #readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_JSON_BODY) throw new Error("リクエストが大きすぎます。");
      chunks.push(chunk);
    }
    if (total === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("JSON として解釈できません。");
    }
  }

  #serveStatic(res, route) {
    const entry = STATIC_FILES.get(route);
    const file = path.join(HERE, "public", entry.file);
    // 許可リストからしか来ないが、念のため配下であることを確認する
    if (!file.startsWith(path.join(HERE, "public"))) return this.#json(res, 403, { error: "拒否されました" });
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      return this.#json(res, 404, { error: "見つかりません" });
    }
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }

  #json(res, status, payload) {
    const body = JSON.stringify(redactValue(payload));
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  }
}

// --------------------------------------------------------------- mappers
function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    source: task.source,
    priority: task.priority,
    state: task.state,
    stateLabel: STATE_LABELS_JA[task.state] ?? task.state,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    branch: task.branch,
    attempts: task.attempts,
    maxAttempts: task.max_attempts,
    revisionCount: task.revision_count,
    maxRevisions: task.max_revisions,
    dependsOn: task.dependsOn,
    blockedReason: task.blocked_reason,
    lastError: task.last_error,
    changedFiles: task.changedFiles,
    gitStartCommit: task.git_start_commit,
    gitEndCommit: task.git_end_commit,
    todoIds: task.todoIds,
    documentId: task.document_id,
    heartbeatAt: task.heartbeat_at,
    retryAfter: task.retry_after,
  };
}

function publicTodo(todo) {
  if (!todo) return null;
  return {
    id: todo.id,
    category: todo.category,
    title: todo.title,
    actionRequired: todo.action_required,
    reason: todo.reason,
    canUseIphone: todo.canUseIphone,
    targetUrl: todo.target_url,
    steps: todo.steps,
    estimatedMinutes: todo.estimated_minutes,
    priority: todo.priority,
    dueAt: todo.due_at,
    completionCondition: todo.completion_condition,
    answerFormat: todo.answer_format,
    answerChoices: todo.answerChoices,
    answerRequired: todo.answerRequired,
    waitingTaskIds: todo.waitingTaskIds,
    status: todo.status,
    createdAt: todo.created_at,
    completedAt: todo.completed_at,
  };
}

function publicDocument(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    originalName: doc.original_name,
    sha256: doc.sha256,
    receivedAt: doc.received_at,
    byteSize: doc.byte_size,
    hasImages: !!doc.has_images,
    hasTables: !!doc.has_tables,
    tableCount: doc.table_count,
    imageCount: doc.image_count,
    parseState: doc.parse_state,
    supersedes: doc.supersedes,
    taskIds: doc.taskIds,
    errorMessage: doc.error_message,
  };
}

/** 秘密を含みうる項目は返さない (§10-4 末尾)。 */
function publicConfig(config) {
  return {
    repoPath: config.repoPath,
    timezone: config.timezone,
    claude: {
      model: config.claude.model,
      permissionMode: config.claude.permissionMode,
      permissionPrompts: config.claude.permissionPrompts,
      maxBudgetUsd: config.claude.maxBudgetUsd,
      timeoutSeconds: config.claude.timeoutSeconds,
      idleTimeoutSeconds: config.claude.idleTimeoutSeconds,
    },
    review: {
      provider: config.review.provider,
      model: config.review.model || "(既定)",
      maxRevisions: config.review.maxRevisions,
      minConfidenceToAccept: config.review.minConfidenceToAccept,
    },
    queue: config.queue,
    intake: config.intake,
    dashboard: {
      host: config.dashboard.host,
      port: config.dashboard.port,
      lanAccess: config.dashboard.lanAccess,
    },
    git: config.git,
  };
}
