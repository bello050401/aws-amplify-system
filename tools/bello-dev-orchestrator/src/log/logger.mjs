/**
 * ファイルログ + ローテーション (指示書 §6-2, §14-1)。
 * 出力は必ず redaction を通す。
 */
import fs from "node:fs";
import path from "node:path";
import { redactText, redactValue } from "./redact.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  #dir;
  #name;
  #level;
  #maxBytes;
  #maxFiles;
  #echo;

  constructor({ dir, name = "orchestrator", level = "info", maxFileBytes = 5 * 1024 * 1024, maxFiles = 10, echo = true }) {
    this.#dir = dir;
    this.#name = name;
    this.#level = LEVELS[level] ?? LEVELS.info;
    this.#maxBytes = maxFileBytes;
    this.#maxFiles = maxFiles;
    this.#echo = echo;
    fs.mkdirSync(dir, { recursive: true });
  }

  get file() {
    return path.join(this.#dir, `${this.#name}.log`);
  }

  #rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.#maxBytes) return;

    // .log -> .log.1 -> .log.2 ... 古いものから捨てる
    for (let i = this.#maxFiles - 1; i >= 1; i -= 1) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > this.#maxFiles) fs.rmSync(from, { force: true });
        else fs.renameSync(from, to);
      }
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* 別プロセスが掴んでいる場合は次回に回す */
    }
  }

  #write(level, message, fields) {
    if ((LEVELS[level] ?? 0) < this.#level) return;
    const at = new Date().toISOString();
    const safeMessage = redactText(String(message));
    const record = { at, level, message: safeMessage };
    if (fields && Object.keys(fields).length) record.fields = redactValue(fields);

    const line = JSON.stringify(record);
    this.#rotateIfNeeded();
    try {
      fs.appendFileSync(this.file, line + "\n", "utf8");
    } catch {
      /* ログが書けないことでシステムを止めない */
    }
    if (this.#echo) {
      const text = `${at} [${level.toUpperCase().padEnd(5)}] ${safeMessage}`;
      try {
        if (level === "error" || level === "warn") process.stderr.write(text + "\n");
        else process.stdout.write(text + "\n");
      } catch {
        /* コンソールが無い環境 (常駐) では無視する */
      }
    }
  }

  debug(msg, fields) {
    this.#write("debug", msg, fields);
  }
  info(msg, fields) {
    this.#write("info", msg, fields);
  }
  warn(msg, fields) {
    this.#write("warn", msg, fields);
  }
  error(msg, fields) {
    this.#write("error", msg, fields);
  }

  /** 保持期間を過ぎた古いログを削除する (§13-3)。 */
  purgeOlderThan(days) {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(this.#dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(this.#dir, entry.name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* 消せないものは放置 */
      }
    }
    return removed;
  }
}
