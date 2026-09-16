-- Explicit opt-in migration. Never appended to the legacy startup schema.
CREATE TABLE IF NOT EXISTS eco_config(version INTEGER PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eco_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER);
CREATE TABLE IF NOT EXISTS eco_events(run_id TEXT NOT NULL,sequence INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
CREATE TABLE IF NOT EXISTS eco_artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eco_cache(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS eco_approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,binding TEXT NOT NULL,expires_at INTEGER NOT NULL,decision TEXT,actor TEXT,consumed_at INTEGER);
CREATE TABLE IF NOT EXISTS eco_idempotency(key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eco_environment_locks(target TEXT PRIMARY KEY,run_id TEXT NOT NULL);
