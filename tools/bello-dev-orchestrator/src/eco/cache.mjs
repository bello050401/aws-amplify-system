import fs from "node:fs";
import path from "node:path";
import { hash } from "./policy.mjs";
const contextFields = [
  "repository",
  "branch",
  "path",
  "contentHash",
  "dependencyDigest",
  "specVersion",
  "policyVersion",
  "schemaVersion",
];
const testFields = [
  "repository",
  "gitSHA",
  "inputDigest",
  "testDigest",
  "command",
  "dependencyDigest",
  "runtime",
  "environmentVersion",
  "fixtureRevision",
  "toolchain",
  "externalVersion",
];
function key(fields, input) {
  if (
    fields.some(
      (k) => input[k] === undefined || input[k] === null || input[k] === "",
    )
  )
    throw Error("Incomplete fingerprint");
  return hash(fields.map((k) => [k, input[k]]));
}
export class EcoCache {
  constructor({ store, enabled = true, now = () => Date.now() }) {
    this.store = store;
    this.enabled = enabled;
    this.now = now;
  }
  putContext(input, summary, readRanges, expiresAt) {
    if (!this.enabled) return null;
    if (!summary || summary.length > 6000)
      throw Error("Summary required and bounded");
    const id = key(contextFields, input);
    this.put(id, "context", { input, summary, readRanges }, expiresAt);
    return id;
  }
  context(input, { sufficient = true } = {}) {
    if (!this.enabled) return { hit: false, reason: "disabled" };
    if (!sufficient) return { hit: false, reason: "summary_insufficient" };
    return this.get(key(contextFields, input));
  }
  putTest(input, record, expiresAt) {
    if (!this.enabled) return null;
    const id = key(testFields, input);
    if (
      record.result !== "passed" ||
      record.flaky ||
      record.healthCheck ||
      !record.evidencePath ||
      !fs.existsSync(record.evidencePath) ||
      (record.external && !record.externalStateProven)
    ) {
      // A newer failure invalidates an older pass under the same key.
      this.put(
        id,
        "test",
        { input, record: { result: "not_reusable" } },
        expiresAt,
      );
      return null;
    }
    this.put(
      id,
      "test",
      {
        input,
        record: {
          ...record,
          evidenceDigest: hash(fs.readFileSync(record.evidencePath)),
        },
      },
      expiresAt,
    );
    return id;
  }
  test(
    input,
    { external = false, externalStateProven = false, healthCheck = false } = {},
  ) {
    if (!this.enabled || healthCheck || (external && !externalStateProven))
      return { hit: false, reason: "must_execute" };
    const r = this.get(key(testFields, input));
    if (r.hit) {
      const record = r.value.record;
      if (
        record.result !== "passed" ||
        record.flaky ||
        record.healthCheck ||
        (record.external && !externalStateProven)
      )
        return { hit: false, reason: "not_reusable" };
      try {
        if (
          hash(fs.readFileSync(record.evidencePath)) !== record.evidenceDigest
        )
          throw Error();
      } catch {
        return { hit: false, reason: "evidence_missing_or_changed" };
      }
    }
    return r;
  }
  put(id, kind, value, expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
      throw Error("Invalid expiry");
    const json = JSON.stringify(value);
    if (
      /(?:Bearer\s|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16}|password\s*[:=]|cookie\s*[:=])/i.test(
        json,
      )
    )
      throw Error("Secret-like cache data rejected");
    this.store.run(
      "INSERT INTO eco_cache(id,kind,data,digest,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,digest=excluded.digest,expires_at=excluded.expires_at",
      [id, kind, json, hash(json), expiresAt],
    );
  }
  get(id) {
    const r = this.store.get("SELECT * FROM eco_cache WHERE id=?", [id]);
    if (!r) return { hit: false, reason: "missing_or_changed" };
    if (r.expires_at <= this.now()) return { hit: false, reason: "expired" };
    try {
      if (hash(r.data) !== r.digest) throw Error();
      return { hit: true, source: id, value: JSON.parse(r.data) };
    } catch {
      return { hit: false, reason: "corrupt" };
    }
  }
  verifyBeforeEdit(file, expected) {
    if (hash(fs.readFileSync(file)) !== expected)
      throw Error("Concurrent edit detected");
  }
}
export function safeEvidence(root, ref) {
  if (typeof ref !== "string" || path.isAbsolute(ref))
    throw Error("Invalid evidence reference");
  const full = fs.realpathSync(path.resolve(root, ref)),
    base = fs.realpathSync(root);
  const relative = path.relative(base, full);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !fs.statSync(full).isFile()
  )
    throw Error("Evidence outside run");
  return { path: ref, digest: hash(fs.readFileSync(full)) };
}
