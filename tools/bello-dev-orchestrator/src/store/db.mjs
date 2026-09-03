/**
 * 永続ストア (指示書 §5, §13-3)。
 *
 * Node 標準の node:sqlite を使う。理由と代替案の検討は
 * docs/ADR-0001-technology-choices.md を参照。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "schema.sql");

export const SCHEMA_VERSION = "1";

/**
 * node:sqlite が使えるかを起動前に確かめる。
 * 使えない Node で「なんとなく落ちる」のではなく、理由を出して止めるため。
 */
export async function probeSqlite() {
  try {
    const mod = await import("node:sqlite");
    if (typeof mod.DatabaseSync !== "function") {
      return { ok: false, reason: "node:sqlite に DatabaseSync がありません。Node 22.5 以降が必要です。" };
    }
    const probe = new mod.DatabaseSync(":memory:");
    probe.exec("CREATE TABLE probe(x INTEGER PRIMARY KEY)");
    probe.close();
    return { ok: true, nodeVersion: process.version };
  } catch (err) {
    return {
      ok: false,
      reason: `node:sqlite を利用できません (${process.version}): ${err.message}. Node 22.5 以降へ更新してください。`,
    };
  }
}

export class Store {
  #db;

  constructor(db) {
    this.#db = db;
  }

  static async open(dbFile) {
    const probe = await probeSqlite();
    if (!probe.ok) throw new Error(probe.reason);

    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);

    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    db.exec(schema);

    const store = new Store(db);
    store.setMeta("schemaVersion", SCHEMA_VERSION);
    return store;
  }

  get raw() {
    return this.#db;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* 既に閉じている */
    }
  }

  /** 単純な同期トランザクション。fn が投げたら必ず ROLLBACK する。 */
  transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* ロールバック不能でも元の例外を優先する */
      }
      throw err;
    }
  }

  run(sql, params = []) {
    return this.#db.prepare(sql).run(...params);
  }

  get(sql, params = []) {
    return this.#db.prepare(sql).get(...params);
  }

  all(sql, params = []) {
    return this.#db.prepare(sql).all(...params);
  }

  setMeta(key, value) {
    this.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
      key,
      String(value),
    ]);
  }

  getMeta(key) {
    return this.get("SELECT value FROM meta WHERE key=?", [key])?.value ?? null;
  }

  /**
   * 整合性検査 (§6-3-2)。壊れた DB のまま走らせない。
   */
  integrityCheck() {
    const rows = this.all("PRAGMA integrity_check");
    const first = rows?.[0];
    const value = first ? Object.values(first)[0] : "unknown";
    return { ok: value === "ok", detail: String(value) };
  }
}
