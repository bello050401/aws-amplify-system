import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_ECO, validateEco, hash } from "./policy.mjs";
import { validateArtifact } from "./artifacts.mjs";
const edges = {
  QUEUED: ["DISCOVERING"],
  DISCOVERING: ["QA_INITIAL"],
  QA_INITIAL: ["SPEC_READY", "COMPLETED_STAGING"],
  SPEC_READY: ["IMPLEMENTING"],
  IMPLEMENTING: ["TESTING", "REPAIR_PENDING"],
  TESTING: ["STAGING_DEPLOYING", "REPAIR_PENDING"],
  STAGING_DEPLOYING: ["QA_VERIFY"],
  QA_VERIFY: ["COMPLETED_STAGING", "REPAIR_PENDING"],
  REPAIR_PENDING: ["IMPLEMENTING"],
};
const waiting = [
  "PAUSED",
  "WAITING_APPROVAL",
  "WAITING_USER_AUTH",
  "WAITING_CAPACITY",
  "HUMAN_REVIEW",
  "FAILED",
  "CANCELLED",
];
export const protectedActions = new Set([
  "production_data",
  "destructive_migration",
  "major_iam",
  "major_s3",
  "major_cognito",
  "real_listing",
  "zaico_production",
  "billing",
]);
export function installEcoSchema(store) {
  store.transaction(() => {
    store.raw.exec(
      fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    store.setMeta("ecoSchemaVersion", "1");
  });
}
export class EcoStore {
  constructor({ store, capabilities = () => ({}), now = () => Date.now() }) {
    this.store = store;
    this.capabilities = capabilities;
    this.now = now;
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    return this.store.transaction(() => {
      this.inTransaction = true;
      try {
        return fn();
      } finally {
        this.inTransaction = false;
      }
    });
  }
  get installed() {
    return !!this.store.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='eco_config'",
    );
  }
  settings() {
    if (!this.installed)
      return {
        version: 0,
        config: {
          ...structuredClone(DEFAULT_ECO),
          mode:
            this.store.getMeta("implementationProvider") === "codex"
              ? "codex_only"
              : "claude_only",
        },
        installed: false,
        capabilities: this.capabilities(),
      };
    const r = this.store.get(
      "SELECT * FROM eco_config ORDER BY version DESC LIMIT 1",
    );
    return {
      version: r?.version || 0,
      config: r
        ? JSON.parse(r.data)
        : {
            ...structuredClone(DEFAULT_ECO),
            mode:
              this.store.getMeta("implementationProvider") === "codex"
                ? "codex_only"
                : "claude_only",
          },
      installed: true,
      capabilities: this.capabilities(),
    };
  }
  idempotent(key, input, fn) {
    if (typeof key !== "string" || key.length < 8 || key.length > 150)
      throw Error("Idempotency key required");
    return this.transaction(() => {
      const digest = hash(input),
        old = this.store.get("SELECT * FROM eco_idempotency WHERE key=?", [
          key,
        ]);
      if (old) {
        if (old.digest !== digest) throw Error("Idempotency conflict");
        return JSON.parse(old.result);
      }
      const result = fn();
      this.store.run("INSERT INTO eco_idempotency VALUES(?,?,?)", [
        key,
        digest,
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  save(config, expectedVersion, key) {
    if (!this.installed) throw Error("Eco migration not installed");
    return this.idempotent(key, { config, expectedVersion }, () => {
      const old = this.settings();
      if (old.version !== expectedVersion)
        throw Error("Configuration version conflict");
      const valid = validateEco(config, this.capabilities());
      const version = old.version + 1;
      const modeChanged =
        old.config.mode !== valid.config.mode ||
        !!old.config.enabled !== !!valid.config.enabled;
      this.store.run("INSERT INTO eco_config VALUES(?,?,?)", [
        version,
        JSON.stringify(valid.config),
        new Date(this.now()).toISOString(),
      ]);
      if (["claude_only", "codex_only"].includes(valid.config.mode))
        this.store.setMeta(
          "implementationProvider",
          valid.config.mode === "codex_only" ? "codex" : "claude",
        );
      // モードや有効/無効の切替は legacy キューへの影響が大きいため、必ず一時停止へ
      // 倒す (§eco queue guard)。同モードでの予算調整などは既存の一時停止状態を保つ。
      if (modeChanged) this.store.setMeta("paused", "1");
      return { version, ...valid };
    });
  }
  create(taskId, { revision, acIds, risk = "low" }, key) {
    return this.idempotent(key, { taskId, revision, acIds, risk }, () => {
      const cfg = this.settings();
      if (!cfg.config.enabled) throw Error("Feature disabled");
      validateEco(cfg.config, this.capabilities());
      if (!this.store.get("SELECT id FROM tasks WHERE id=?", [taskId]))
        throw Error("Unknown task");
      if (
        typeof revision !== "string" ||
        !revision ||
        !Array.isArray(acIds) ||
        !acIds.length ||
        new Set(acIds).size !== acIds.length
      )
        throw Error("Revision and unique AC required");
      const id = "eco_" + crypto.randomUUID().replaceAll("-", "");
      const data = {
        configSnapshot: cfg.config,
        configVersion: cfg.version,
        revision,
        acIds,
        risk,
        repairCount: 0,
        logicalFailures: 0,
        communicationFailures: 0,
        artifactFailures: 0,
        startedAt: this.now(),
        deadline: this.now() + cfg.config.maxElapsedSeconds * 1000,
        usage: {
          measuredTokens: 0,
          estimatedTokens: 0,
          costUsd: 0,
          costKnown: true,
        },
        pendingEffect: null,
        resumeState: null,
      };
      this.store.run(
        "INSERT INTO eco_runs(id,task_id,version,state,data) VALUES(?,?,1,?,?)",
        [id, taskId, "QUEUED", JSON.stringify(data)],
      );
      this.event(id, 1, null, "QUEUED", "run requested", "user");
      return this.get(id);
    });
  }
  get(id) {
    const r = this.store.get("SELECT * FROM eco_runs WHERE id=?", [id]);
    return r ? { ...r, ...JSON.parse(r.data) } : null;
  }
  list() {
    return this.installed
      ? this.store
          .all("SELECT id FROM eco_runs ORDER BY rowid DESC LIMIT 100")
          .map((r) => this.get(r.id))
      : [];
  }
  event(id, sequence, from, to, reason, actor) {
    this.store.run("INSERT INTO eco_events VALUES(?,?,?)", [
      id,
      sequence,
      JSON.stringify({
        runId: id,
        sequence,
        previousState: from,
        nextState: to,
        reason,
        actor,
        timestamp: new Date(this.now()).toISOString(),
      }),
    ]);
  }
  mutate(id, version, next, patch = {}, reason = "", actor = "worker") {
    return this.transaction(() => {
      const r = this.get(id);
      if (!r || r.version !== version) throw Error("Run version conflict");
      if (["COMPLETED_STAGING", "FAILED", "CANCELLED"].includes(r.state))
        throw Error("Terminal run");
      if (
        next !== r.state &&
        !waiting.includes(next) &&
        !(edges[r.state] || []).includes(next) &&
        !(actor === "operator" && r.state === "HUMAN_REVIEW" && next === "COMPLETED_STAGING") &&
        !(waiting.includes(r.state) && next === r.resumeState)
      )
        throw Error("Invalid transition");
      const data = { ...JSON.parse(r.data), ...patch };
      if (waiting.includes(next) && !waiting.includes(r.state))
        data.resumeState = r.state;
      if (next === "REPAIR_PENDING" && r.state !== "REPAIR_PENDING") {
        if (r.repairCount >= r.configSnapshot.maxRepairLoops) {
          next = "HUMAN_REVIEW";
          // Preserve the failed verification phase so an operator can fix an
          // environmental issue, extend the bounded repair allowance, and
          // resume without discarding the audited run.
          data.resumeState = r.state;
          reason = "Repair limit reached";
        } else {
          data.repairCount = r.repairCount + 1;
          data.logicalFailures = r.logicalFailures + 1;
        }
      }
      this.store.run(
        "UPDATE eco_runs SET version=version+1,state=?,data=? WHERE id=? AND version=?",
        [next, JSON.stringify(data), id, version],
      );
      this.event(id, version + 1, r.state, next, reason, actor);
      return this.get(id);
    });
  }
  acquire(id, worker, ttl = 60000) {
    const r = this.store.run(
      "UPDATE eco_runs SET lease_owner=?,lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<? OR lease_owner=?)",
      [worker, this.now() + ttl, id, this.now(), worker],
    );
    return r.changes === 1;
  }
  release(id, worker) {
    this.store.run(
      "UPDATE eco_runs SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?",
      [id, worker],
    );
  }
  ownsLease(id, worker) {
    const run = this.store.get(
      "SELECT lease_owner,lease_until FROM eco_runs WHERE id=?",
      [id],
    );
    return run?.lease_owner === worker && run.lease_until > this.now();
  }
  reserveEnvironment(runId, target) {
    return this.transaction(() => {
      const r = this.store.get(
        "SELECT * FROM eco_environment_locks WHERE target=?",
        [target],
      );
      if (r && r.run_id !== runId)
        throw Error("Staging is reserved by another run");
      this.store.run(
        "INSERT OR IGNORE INTO eco_environment_locks VALUES(?,?)",
        [target, runId],
      );
    });
  }
  releaseEnvironment(runId) {
    this.store.run("DELETE FROM eco_environment_locks WHERE run_id=?", [runId]);
  }
  getArtifact(id) {
    const row = this.store.get("SELECT id,data FROM eco_artifacts WHERE id=?", [id]);
    return row ? { ...JSON.parse(row.data), id: row.id } : null;
  }
  artifact(id, version, a, root) {
    return this.transaction(() => {
      const run = this.get(id);
      if (run.version !== version) throw Error("Run version conflict");
      const valid = validateArtifact(a, {
        runId: id,
        revision: run.revision,
        evidenceRoot: root,
        acIds: run.acIds,
      });
      for (const parent of a.parentArtifactIds)
        if (
          !this.store.get(
            "SELECT id FROM eco_artifacts WHERE id=? AND run_id=?",
            [parent, id],
          )
        )
          throw Error("Invalid artifact parent");
      const artifactId = a.id || "art_" + crypto.randomUUID();
      if (
        this.store.get("SELECT id FROM eco_artifacts WHERE id=?", [artifactId])
      )
        throw Error("Immutable artifact already exists");
      this.store.run("INSERT INTO eco_artifacts VALUES(?,?,?,?,?,?)", [
        artifactId,
        id,
        a.revision,
        a.kind,
        valid.digest,
        JSON.stringify(valid),
      ]);
      return { ...valid, id: artifactId };
    });
  }
  requestApproval(runId, action, target, digest, expiry) {
    if (
      !protectedActions.has(action) ||
      !target ||
      !digest ||
      expiry <= this.now()
    )
      throw Error("Invalid approval binding");
    const id = "approval_" + crypto.randomUUID();
    const binding = JSON.stringify({ runId, action, target, digest });
    this.store.run(
      "INSERT INTO eco_approvals(id,run_id,binding,expires_at) VALUES(?,?,?,?)",
      [id, runId, binding, expiry],
    );
    return { id, binding };
  }
  decideApproval(id, decision, { actor, role }) {
    if (
      role !== "human" ||
      !actor ||
      !["approved", "rejected"].includes(decision)
    )
      throw Error("Human authorization required");
    return this.transaction(() => {
      const r = this.store.get("SELECT * FROM eco_approvals WHERE id=?", [id]);
      if (!r || r.decision || r.expires_at <= this.now())
        throw Error("Approval unavailable");
      this.store.run("UPDATE eco_approvals SET decision=?,actor=? WHERE id=?", [
        decision,
        actor,
        id,
      ]);
    });
  }
  consumeApproval(id, binding) {
    return this.transaction(() => {
      const r = this.store.get("SELECT * FROM eco_approvals WHERE id=?", [id]);
      if (
        !r ||
        r.decision !== "approved" ||
        r.consumed_at !== null ||
        r.expires_at <= this.now() ||
        r.binding !== JSON.stringify(binding)
      )
        throw Error("Approval invalid or expired");
      this.store.run("UPDATE eco_approvals SET consumed_at=? WHERE id=?", [
        this.now(),
        id,
      ]);
      return true;
    });
  }
}
