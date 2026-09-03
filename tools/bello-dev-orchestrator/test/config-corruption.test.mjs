/**
 * 設定ファイル破損の回帰テスト。
 *
 * 2026-09-03 の障害 (bello-orchestrator.config.json が文字化けして JSON として
 * 壊れ、Orchestrator が代替設定で起動していた) を二度と起こさないための守り。
 *
 * 押さえる観点は 4 つ:
 *   1. 文字化け   — CP932 で読み書きされた設定を必ず検出する
 *   2. 壊れた JSON — 既定値で黙って動かず、診断モードへ倒す
 *   3. 書き込み途中 — 一時ファイル → 検証 → atomic replace で torn write を作らない
 *   4. 再起動     — タスク / DB / worktree / ログを失わずに再開できる
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import {
  readConfigFile,
  writeConfigFile,
  writeFileAtomic,
  detectMojibake,
  quarantineConfigFile,
  salvageConfigText,
  stripCommentBlock,
  sha256OfFile,
} from "../src/configFile.mjs";
import { loadConfig } from "../src/config.mjs";
import { startDiagnosticDashboard, buildComparison } from "../src/diagnosticMode.mjs";

const GOOD_CONFIG = {
  $comment: ["ASCII only on purpose."],
  repoPath: "",
  dataRoot: "",
  claude: {
    permissionMode: "acceptEdits",
    permissionPrompts: "none",
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 900,
    allowedTools: ["Read", "Bash(npm test:*)"],
    disallowedTools: ["Bash(git push:*)"],
    extraArgs: [],
  },
  review: { provider: "claude" },
  git: {
    isolation: "worktree",
    allowPush: false,
    protectedBranches: ["main", "master", "production"],
  },
};

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-config-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeGoodConfig(dir, overrides = {}) {
  const file = path.join(dir, "bello-orchestrator.config.json");
  const cfg = { ...GOOD_CONFIG, ...overrides, repoPath: overrides.repoPath ?? dir };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return file;
}

/**
 * 実際に起きた壊れ方を再現する。
 * UTF-8 のバイト列を CP932 として読み、その結果を UTF-8 として書き戻す
 * (PowerShell 5.1 の Get-Content -Raw → Set-Content の往復と同じ)。
 * CP932 の 2 バイト目には 0x5C (\) が含まれるので、JSON のエスケープも壊れる。
 */
function mojibakeRoundTrip(text) {
  const utf8Bytes = Buffer.from(text, "utf8");
  // CP932 の完全実装は要らない。障害と同じ「E3 81 xx → 縺」の化け方を作れば十分。
  const decoder = new TextDecoder("shift_jis", { fatal: false });
  return decoder.decode(utf8Bytes);
}

// ---------------------------------------------------------------- 1. 文字化け

test("文字化けした $comment を検出する (UTF-8 を CP932 として読んだ場合)", () => {
  const japanese = '{\n  "$comment": ["日本語の運用設定コメント"],\n  "repoPath": "C:\\\\repo"\n}\n';
  const broken = mojibakeRoundTrip(japanese);

  const issues = detectMojibake(broken);
  assert.ok(issues.length > 0, "文字化けを検出できていない");
  assert.ok(
    issues.some((i) => i.kind === "cp932_mojibake" || i.kind === "replacement_char"),
    `想定した種類の検出になっていない: ${JSON.stringify(issues.map((i) => i.kind))}`,
  );
});

test("健全な ASCII / UTF-8 設定を誤検出しない", () => {
  const dir = tmpDir();
  const file = writeGoodConfig(dir);
  const read = readConfigFile(file);
  assert.deepEqual(read.issues, [], "健全な設定を壊れていると誤判定した");
  assert.ok(read.parsed);
  assert.equal(read.hadBom, false);
});

test("CP932 で保存された設定ファイルを UTF-8 として黙って読み流さない", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  // 不正な UTF-8 バイト列 (CP932 の「日本語」) をそのまま置く。
  const cp932 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x93, 0xfa, 0x96, 0x7b, 0x22, 0x7d]);
  fs.writeFileSync(file, cp932);

  const read = readConfigFile(file);
  assert.ok(
    read.issues.some((i) => i.kind === "wrong_encoding"),
    "UTF-8 として不正なバイト列を検出できていない",
  );
  assert.equal(read.parsed, null, "壊れたファイルから設定を作ってしまっている");
});

test("UTF-8 BOM 付きでも読めるが、BOM が付いていたことを記録する", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  const body = JSON.stringify({ ...GOOD_CONFIG, repoPath: dir }, null, 2) + "\n";
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]));

  const read = readConfigFile(file);
  assert.deepEqual(read.issues, []);
  assert.equal(read.hadBom, true);
  assert.equal(read.parsed.git.isolation, "worktree");
});

// ------------------------------------------------------------- 2. 壊れた JSON

test("壊れた JSON では既定値で起動せず、errors と corruption を返す", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  fs.writeFileSync(file, '{\n  "$comment": ["壊れた\n  "repoPath": "C:\\\\repo",\n}\n', "utf8");

  const loaded = loadConfig(file);
  assert.ok(loaded.errors.length > 0, "壊れた設定なのにエラーになっていない");
  assert.equal(loaded.config, null, "壊れた設定から代替設定を組み立ててしまっている");
  assert.ok(loaded.corruption, "破損の証拠が残っていない");
  assert.ok(loaded.corruption.sha256, "破損版の SHA-256 が無い");
});

test("$comment だけが壊れている場合、ユーザー設定を失わずに救出できる", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  // $comment の中で引用符と改行が壊れている。それ以外は正しい。
  const corrupted = [
    "{",
    '  "$comment": [',
    '    "繧ｷ繧ｹ繝?繝  - 螢翫ｌ縺溘さ繝｡繝ｳ繝',
    '    "謾ｹ陦後∪縺ｧ螢翫ｌ縺ｦ縺?繧',
    '  "repoPath": "C:\\\\Users\\\\win\\\\Documents\\\\GitHub\\\\aws-amplify-system",',
    '  "dataRoot": "",',
    '  "claude": {',
    '    "permissionMode": "acceptEdits",',
    '    "permissionPrompts": "none",',
    '    "timeoutSeconds": 3600,',
    '    "idleTimeoutSeconds": 900,',
    '    "allowedTools": ["Read", "Bash(npm test:*)"],',
    '    "disallowedTools": ["Bash(git push:*)"],',
    '    "extraArgs": []',
    "  },",
    '  "review": { "provider": "claude" },',
    '  "git": {',
    '    "isolation": "worktree",',
    '    "allowPush": false,',
    '    "protectedBranches": ["main", "master", "production"]',
    "  }",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(file, corrupted, "utf8");

  const read = readConfigFile(file);
  assert.ok(read.issues.length > 0, "壊れていることを検出できていない");

  const salvage = salvageConfigText(read.text);
  assert.equal(salvage.salvaged, true, `救出できていない: ${salvage.reason}`);

  // ユーザー設定が 1 つも失われていないこと。ここが今回の要件の中核。
  assert.equal(salvage.config.git.isolation, "worktree");
  assert.equal(salvage.config.git.allowPush, false);
  assert.deepEqual(salvage.config.git.protectedBranches, ["main", "master", "production"]);
  assert.equal(salvage.config.review.provider, "claude");
  assert.deepEqual(salvage.config.claude.allowedTools, ["Read", "Bash(npm test:*)"]);
  assert.deepEqual(salvage.config.claude.disallowedTools, ["Bash(git push:*)"]);
  assert.equal(salvage.config.repoPath, "C:\\Users\\win\\Documents\\GitHub\\aws-amplify-system");
  assert.ok(!("$comment" in salvage.config), "壊れた $comment が残っている");
});

test("$comment 以外まで壊れている場合は救出したことにしない", () => {
  const text = '{\n  "repoPath": "C:\\\\repo",\n  "git": { "isolation": \n}\n';
  const salvage = salvageConfigText(text);
  assert.equal(salvage.salvaged, false);
  assert.equal(salvage.config, null, "救出できていないのに設定を返している");
});

test("stripCommentBlock は $comment だけを落とし、後続のキーを残す", () => {
  const text = ['{', '  "$comment": [', '    "壊れた', '  "keep": 1', "}"].join("\n");
  const out = stripCommentBlock(text);
  assert.equal(out.changed, true);
  assert.ok(out.text.includes('"keep": 1'), "後続のキーまで消してしまっている");
  assert.ok(!out.text.includes("$comment"));
});

test("salvage を明示しない限り、壊れた設定から config を組み立てない", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  fs.writeFileSync(file, '{\n  "$comment": ["壊れた\n  "repoPath": "' + dir.replaceAll("\\", "\\\\") + '"\n}\n', "utf8");

  const strict = loadConfig(file);
  assert.equal(strict.config, null, "既定で代替設定を作ってしまっている");

  const permissive = loadConfig(file, { salvage: true });
  assert.ok(permissive.config, "明示的に許可しても救出できていない");
  assert.ok(permissive.warnings.some((w) => w.includes("隔離")), "救出したことが警告に出ていない");
});

// -------------------------------------------------------- 3. 書き込み途中/atomic

test("設定の書き出しは UTF-8 (BOM 無し) で、読み直して JSON になる", () => {
  const dir = tmpDir();
  const file = path.join(dir, "out.json");
  writeConfigFile(file, { ...GOOD_CONFIG, repoPath: dir });

  const bytes = fs.readFileSync(file);
  assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), "BOM を付けてしまっている");

  const read = readConfigFile(file);
  assert.deepEqual(read.issues, []);
  assert.equal(read.parsed.git.isolation, "worktree");
});

test("書き込み検証に失敗したら元のファイルを壊さない", () => {
  const dir = tmpDir();
  const file = path.join(dir, "keep.json");
  fs.writeFileSync(file, '{"original": true}\n', "utf8");
  const before = sha256OfFile(file);

  assert.throws(() => {
    writeFileAtomic(file, "not json at all", {
      verify: (text) => JSON.parse(text), // ここで必ず失敗する
    });
  });

  assert.equal(sha256OfFile(file), before, "検証に失敗したのに元ファイルが書き換わっている");
  assert.equal(fs.readFileSync(file, "utf8"), '{"original": true}\n');
});

test("書き込み途中の一時ファイルを残さない", () => {
  const dir = tmpDir();
  const file = path.join(dir, "atomic.json");

  writeConfigFile(file, { ...GOOD_CONFIG, repoPath: dir });
  try {
    writeFileAtomic(file, "broken", { verify: () => { throw new Error("fail"); } });
  } catch {
    /* 想定どおり */
  }

  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `一時ファイルが残っている: ${leftovers.join(", ")}`);
});

test("書き込み途中で切れたファイル (torn write) を壊れていると判定する", () => {
  const dir = tmpDir();
  const file = path.join(dir, "torn.json");
  const full = JSON.stringify({ ...GOOD_CONFIG, repoPath: dir }, null, 2) + "\n";
  // ディスクに半分だけ届いた状態を作る。
  fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)), "utf8");

  const read = readConfigFile(file);
  assert.ok(
    read.issues.some((i) => i.kind === "invalid_json"),
    "途中で切れた設定を正常扱いしている",
  );
  assert.equal(read.parsed, null);
});

test("NUL が混ざった書きかけファイルを制御文字として検出する", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nul.json");
  fs.writeFileSync(file, '{\n  "repoPath": "C:\\\\repo"\u0000\u0000\u0000\n}\n', "utf8");

  const read = readConfigFile(file);
  assert.ok(read.issues.some((i) => i.kind === "control_char"), "生の制御文字を検出できていない");
});

test("書き出した設定に文字化けが混ざっていたら書き込みを中止する", () => {
  const dir = tmpDir();
  const file = path.join(dir, "mojibake.json");
  assert.throws(
    () => writeConfigFile(file, { note: "繧ｷ繧ｹ繝ﾃ繝" }),
    /文字化け/,
    "文字化けしたまま書き出してしまっている",
  );
  assert.equal(fs.existsSync(file), false, "中止したのにファイルができている");
});

// -------------------------------------------------------------- 4. 隔離と証拠

test("隔離しても元ファイルを削除せず、SHA-256 が一致する", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  fs.writeFileSync(file, '{ "broken": \n', "utf8");
  const originalSha = sha256OfFile(file);

  const q = quarantineConfigFile(file, { issues: [{ kind: "invalid_json", message: "test" }], reason: "test" });

  assert.equal(fs.existsSync(file), true, "元ファイルを消してしまっている");
  assert.equal(sha256OfFile(file), originalSha, "元ファイルが変わっている");
  assert.equal(fs.existsSync(q.copyPath), true, "隔離コピーが無い");
  assert.equal(q.meta.sha256, originalSha, "隔離コピーの SHA-256 が元と違う");

  const meta = JSON.parse(fs.readFileSync(q.metaPath, "utf8"));
  assert.equal(meta.sha256, originalSha);
  assert.equal(meta.reason, "test");
  assert.ok(meta.issues.length > 0, "検出した問題がメタ情報に残っていない");
});

// ------------------------------------------------------- 5. 診断モードと再起動

test("診断モードは読み取り専用で、Claude 実行を停止と明示する", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "bello-orchestrator.config.json");
  fs.writeFileSync(file, '{ "$comment": ["壊れた\n', "utf8");
  const loaded = loadConfig(file);

  const diag = await startDiagnosticDashboard({
    configPath: file,
    corruption: loaded.corruption,
    quarantine: null,
    port: 0, // 空きポートを OS に選ばせる
  });

  try {
    const state = await getJson(`${diag.url}api/diagnostic`);
    assert.equal(state.mode, "diagnostic");
    assert.match(state.claudeExecution, /停止中/);
    assert.match(state.queueProcessing, /停止中/);
    assert.match(state.inboxWatch, /停止中/);

    // 書き込み系は受け付けない。
    const post = await request(`${diag.url}api/settings/review-provider`, "POST");
    assert.equal(post.status, 405, "診断モードで書き込みを受け付けてしまっている");
  } finally {
    await diag.close();
  }
});

test("Git の正常版 / 壊れた版 / 適用された設定を突き合わせられる", () => {
  const gitText = JSON.stringify({
    git: { isolation: "worktree", allowPush: false, protectedBranches: ["main"] },
    review: { provider: "claude" },
  });
  const corruption = {
    salvage: { salvaged: true, config: { git: { isolation: "worktree", allowPush: false } } },
  };
  const applied = { git: { isolation: "in-place", allowPush: true }, review: { provider: "manual" } };

  const rows = buildComparison({ corruption, gitText, appliedConfig: applied });
  const isolation = rows.find((r) => r.key === "git.isolation");
  assert.equal(isolation.git, "worktree");
  assert.equal(isolation.applied, "in-place", "代替設定との差分を見せられていない");

  const push = rows.find((r) => r.key === "git.allowPush");
  assert.equal(push.git, "false");
  assert.equal(push.applied, "true");
});

test("修復して再起動しても、設定と実行時データの場所が変わらない", () => {
  const dir = tmpDir();
  const dataRoot = path.join(dir, "runtime");
  fs.mkdirSync(path.join(dataRoot, "worktrees"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "orchestrator.db"), "pretend-db", "utf8");
  fs.writeFileSync(path.join(dataRoot, "logs", "orchestrator.log"), "既存のログ\n", "utf8");
  fs.writeFileSync(path.join(dataRoot, "worktrees", "task-1.txt"), "作業中\n", "utf8");

  const file = writeGoodConfig(dir, { dataRoot });

  // 起動 1 回目に相当する読み込み。
  const first = loadConfig(file);
  assert.deepEqual(first.errors, []);
  const firstPaths = first.paths;

  // ここで設定が壊れ、修復されたとする。
  const corrupted = fs.readFileSync(file, "utf8").replace('"$comment": [', '"$comment": ["繧ｷ繧ｹ繝\n  [');
  fs.writeFileSync(file, corrupted, "utf8");
  const broken = loadConfig(file);
  assert.ok(broken.errors.length > 0);
  assert.equal(broken.config, null, "壊れた設定で起動しようとしている");

  quarantineConfigFile(file, { issues: broken.corruption.issues, reason: "test" });
  const salvage = salvageConfigText(broken.corruption.text);
  assert.equal(salvage.salvaged, true, `救出できていない: ${salvage.reason}`);
  writeConfigFile(file, salvage.config);

  // 再起動に相当する読み込み。
  const second = loadConfig(file);
  assert.deepEqual(second.errors, [], `再起動できない: ${second.errors.join(" / ")}`);
  assert.equal(second.paths.dataRoot, firstPaths.dataRoot, "dataRoot が変わっている (別の DB を掴む)");
  assert.equal(second.paths.dbFile, firstPaths.dbFile);
  assert.equal(second.paths.worktreeRoot, firstPaths.worktreeRoot);
  assert.equal(second.paths.logDir, firstPaths.logDir);

  // 停止中のタスク / DB / worktree / ログが失われていないこと。
  assert.equal(fs.readFileSync(second.paths.dbFile, "utf8"), "pretend-db");
  assert.equal(fs.readFileSync(path.join(second.paths.logDir, "orchestrator.log"), "utf8"), "既存のログ\n");
  assert.equal(fs.readFileSync(path.join(second.paths.worktreeRoot, "task-1.txt"), "utf8"), "作業中\n");

  // 安全境界が復旧後も効いていること。
  assert.equal(second.config.git.isolation, "worktree");
  assert.equal(second.config.git.allowPush, false);
  assert.deepEqual(second.config.git.protectedBranches, ["main", "master", "production"]);
  assert.equal(second.config.review.provider, "claude");
  assert.ok(second.config.claude.allowedTools.length > 0);
  assert.ok(second.config.claude.disallowedTools.includes("Bash(git push:*)"));
});

// ------------------------------------------------------------------ ヘルパー

function request(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getJson(url) {
  const res = await request(url);
  assert.equal(res.status, 200, `GET ${url} が ${res.status}`);
  return JSON.parse(res.body);
}
