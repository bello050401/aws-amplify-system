-- BELLO 自律開発管理システム 永続ストア (指示書 §5)
-- 時刻はすべて UTC の ISO8601 文字列で保存する (§10-3: 内部保存は UTC)。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  instruction       TEXT NOT NULL,
  source            TEXT NOT NULL,          -- user_document | user_ui | review_engine | recovery | system
  priority          INTEGER NOT NULL DEFAULT 50,
  state             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  repo_path         TEXT NOT NULL,
  branch            TEXT,
  work_dir          TEXT,
  depends_on        TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
  blocked_reason    TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  revision_count    INTEGER NOT NULL DEFAULT 0,
  max_revisions     INTEGER NOT NULL DEFAULT 3,
  session_id        TEXT,
  git_start_commit  TEXT,
  git_end_commit    TEXT,
  changed_files     TEXT NOT NULL DEFAULT '[]',   -- JSON array
  test_summary      TEXT,
  report_id         TEXT,
  review_id         TEXT,
  todo_ids          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  idempotency_key   TEXT NOT NULL,
  cancel_reason     TEXT,
  last_error        TEXT,
  document_id       TEXT,
  retry_after       TEXT,                          -- retry_wait 用の再開時刻
  heartbeat_at      TEXT,
  last_failure_signature TEXT,                     -- 同一失敗の連続検知 (§7-4)
  review_failures   INTEGER NOT NULL DEFAULT 0     -- 審査が連続で失敗した回数
);

-- 冪等性キー: 同じ指示を二重登録しない (§5-1, §14-1)
CREATE UNIQUE INDEX IF NOT EXISTS ix_tasks_idempotency ON tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS ix_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS ix_tasks_priority ON tasks(priority DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS task_state_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  reason     TEXT,
  actor      TEXT NOT NULL DEFAULT 'system',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_history_task ON task_state_history(task_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt    INTEGER NOT NULL,
  status     TEXT NOT NULL,             -- completed | partial | blocked | failed
  json       TEXT NOT NULL,             -- 完了報告 (redaction 済み)
  raw_valid  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reports_task ON reports(task_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  report_id      TEXT,
  decision       TEXT NOT NULL,         -- accept_and_continue | revision_required | ...
  confidence     REAL,
  json           TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  usage          TEXT,
  provider       TEXT NOT NULL DEFAULT 'openai',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reviews_task ON reviews(task_id, created_at);

CREATE TABLE IF NOT EXISTS todos (
  id                   TEXT PRIMARY KEY,
  category             TEXT NOT NULL,   -- auth|mfa|oauth|visual_review|approval|paid_action|destructive_action|specification_decision|other
  title                TEXT NOT NULL,
  action_required      TEXT NOT NULL,
  reason               TEXT NOT NULL,
  can_use_iphone       INTEGER NOT NULL DEFAULT 0,
  target_url           TEXT,
  steps                TEXT NOT NULL DEFAULT '[]',   -- JSON array
  estimated_minutes    INTEGER,
  priority             TEXT NOT NULL DEFAULT 'normal', -- urgent | normal
  due_at               TEXT,
  completion_condition TEXT NOT NULL,
  answer_format        TEXT NOT NULL DEFAULT 'checkbox', -- checkbox|text|choice|file|screenshot
  answer_choices       TEXT NOT NULL DEFAULT '[]',
  answer_required      INTEGER NOT NULL DEFAULT 0,
  waiting_task_ids     TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'open',  -- open|completed|cancelled|expired
  created_at           TEXT NOT NULL,
  completed_at         TEXT,
  completed_answer     TEXT,
  attachment_path      TEXT,
  dedupe_key           TEXT NOT NULL,
  -- 'action' = 人にやってもらう依頼 / 'manual_review' = 手動審査の判定待ち
  kind                 TEXT NOT NULL DEFAULT 'action',
  resume_dispatched    INTEGER NOT NULL DEFAULT 0     -- 依存解除を一度しか実行しないため (§8-2)
);
-- 同じ TODO を繰り返し作らない (§8-3 「既に満たされている項目を繰り返し要求しない」)
CREATE UNIQUE INDEX IF NOT EXISTS ix_todos_dedupe_open ON todos(dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_todos_status ON todos(status, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  original_name   TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  extracted_text  TEXT,
  has_images      INTEGER NOT NULL DEFAULT 0,
  has_tables      INTEGER NOT NULL DEFAULT 0,
  table_count     INTEGER NOT NULL DEFAULT 0,
  image_count     INTEGER NOT NULL DEFAULT 0,
  parse_state     TEXT NOT NULL,        -- received|extracting|extracted|converted|duplicate|error
  duplicate_of    TEXT,
  supersedes      TEXT,
  task_ids        TEXT NOT NULL DEFAULT '[]',
  stored_path     TEXT,
  error_message   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_documents_sha ON documents(sha256);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase      TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_checkpoints_task ON checkpoints(task_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,          -- system | user | review_engine | claude | watchdog
  action  TEXT NOT NULL,
  target  TEXT,
  result  TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at DESC);

-- 冪等性: 同じ外部操作を二重実行しないための汎用キー置き場 (§6-3)
CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  result     TEXT,
  created_at TEXT NOT NULL
);
