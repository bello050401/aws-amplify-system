/** テスト用ヘルパー。実 Claude / 実 OpenAI を一切呼ばない。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { derivePaths, ensureDirs } from "../src/config.mjs";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { Logger } from "../src/log/logger.mjs";
import { Orchestrator } from "../src/core/orchestrator.mjs";
import { TodoManager } from "../src/todo/todoManager.mjs";
import { DocumentIntake } from "../src/intake/documentIntake.mjs";
import { FakeClaudeRunner } from "../src/runner/fakeRunner.mjs";
import { FakeReviewEngine } from "../src/review/fakeReview.mjs";

export function tempDir(prefix = "bello-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeConfig(overrides = {}) {
  const dataRoot = tempDir("bello-data-");
  const repoPath = overrides.repoPath ?? tempDir("bello-repo-");
  return {
    repoPath,
    dataRoot,
    claude: {
      executable: "",
      model: "sonnet",
      permissionMode: "acceptEdits",
      permissionPrompts: "none",
      allowedTools: ["Read", "Bash(node:*)"],
      disallowedTools: ["Bash(git push:*)"],
      maxBudgetUsd: 1,
      timeoutSeconds: 120,
      idleTimeoutSeconds: 60,
      extraArgs: [],
    },
    review: {
      provider: "claude",
      claude: { model: "sonnet", timeoutSeconds: 120, maxBudgetUsd: 1, allowedTools: [], disallowedTools: [] },
      model: "",
      maxRevisions: 2,
      requestTimeoutSeconds: 30,
      maxRetries: 1,
      baseBackoffSeconds: 0,
      maxBackoffSeconds: 0,
      maxDiffChars: 1000,
      minConfidenceToAccept: 0.5,
    },
    queue: { maxAttempts: 2, retryBaseSeconds: 0, retryMaxSeconds: 0, heartbeatWarnSeconds: 900, pollIntervalSeconds: 1 },
    intake: { maxFileBytes: 1024 * 1024, stableChecks: 2, stableIntervalMs: 5, pollIntervalSeconds: 60 },
    // port は使わない (enabled=false) が、設定検証は 1..65535 を要求するので正当な値にする
    dashboard: { enabled: false, host: "127.0.0.1", port: 4399, lanAccess: false, lanAccessTokenEnvVar: "BELLO_DASHBOARD_TOKEN" },
    logging: { level: "error", retentionDays: 30, maxFileBytes: 1024 * 1024, maxFiles: 3 },
    timezone: "Asia/Tokyo",
    git: { autoCommit: false, allowPush: false, protectedBranches: ["main"] },
    ...overrides,
  };
}

/** テスト用の完全な組み立て。Runner と Review はすべて fake。 */
export async function buildHarness(configOverrides = {}) {
  const config = makeConfig(configOverrides);
  const paths = derivePaths(config);
  ensureDirs(paths);

  const logger = new Logger({ dir: paths.logDir, name: "test", level: "error", echo: false });
  const store = await Store.open(paths.dbFile);
  const repo = new Repo(store);
  const todoManager = new TodoManager({ repo, logger });
  const runner = new FakeClaudeRunner();
  const reviewEngine = new FakeReviewEngine();
  const intake = new DocumentIntake({ config, paths, repo, logger });
  const orchestrator = new Orchestrator({ config, paths, repo, logger, runner, reviewEngine, todoManager });

  return {
    config,
    paths,
    logger,
    store,
    repo,
    todoManager,
    runner,
    reviewEngine,
    intake,
    orchestrator,
    cleanup() {
      store.close();
      try {
        fs.rmSync(paths.dataRoot, { recursive: true, force: true });
      } catch {
        /* Windows でファイルが掴まれている場合は放置 */
      }
    },
  };
}

/** 空の git リポジトリを作る。 */
export function initRepo(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// ------------------------------------------------------------ ZIP writer
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 無圧縮 (store) の ZIP を組み立てる。docxReader は method 0 / 8 の両方を読める。
 * @param {Array<{name:string, data:Buffer|string}>} files
 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const DOCX_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">';

/** 最小の .docx を作る。 */
export function makeDocx({ paragraphs = [], headings = [], table = null, extraFiles = [] } = {}) {
  let body = "<w:body>";
  for (const h of headings) {
    body += `<w:p><w:pPr><w:pStyle w:val="Heading${h.level ?? 1}"/></w:pPr><w:r><w:t>${h.text}</w:t></w:r></w:p>`;
  }
  for (const p of paragraphs) {
    if (typeof p === "string") body += `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`;
    else if (p.list) body += `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>${p.list}</w:t></w:r></w:p>`;
  }
  if (table) {
    body += "<w:tbl>";
    for (const row of table) {
      body += "<w:tr>";
      for (const cell of row) body += `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`;
      body += "</w:tr>";
    }
    body += "</w:tbl>";
  }
  body += "</w:body>";

  return makeZip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
    { name: "word/document.xml", data: DOCX_HEADER + body + "</w:document>" },
    ...extraFiles,
  ]);
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
