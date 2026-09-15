/**
 * QA-003: 停止検出と進捗の正確化。
 *
 * 実 Claude / 実 OpenAI は呼ばない。実サーバー・実データ置き場にも触れない
 * (すべて一時ポート・一時ディレクトリの合成 fixture)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { probeHealth } from "../src/core/healthProbe.mjs";
import { pipelineOf, Dashboard } from "../src/dashboard/server.mjs";
import { STATES } from "../src/core/states.mjs";
import { makeReport } from "../src/runner/fakeRunner.mjs";
import { makeReview } from "../src/review/fakeReview.mjs";
import { Diagnostics } from "../src/diagnostics.mjs";
import { DocumentIntake } from "../src/intake/documentIntake.mjs";
import { buildHarness } from "./helpers.mjs";

/** listen(0) で空きポートを取り、閉じてから使う。テスト間の取り合いを避ける。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

// ------------------------------------------------------- probeHealth (§1)
test("probeHealth: 正常応答は ok:true を有限時間で返す", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  try {
    const result = await probeHealth({ host: "127.0.0.1", port, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.reachable, true);
    assert.equal(result.status, 200);
    assert.ok(result.latencyMs < 2000);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("probeHealth: 接続拒否 (プロセス不在) を有限時間で見分ける", async () => {
  const port = await freePort(); // 直後に閉じているので誰も listen していない
  const startedAt = Date.now();
  const result = await probeHealth({ host: "127.0.0.1", port, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.reachable, false);
  assert.ok(Date.now() - startedAt < 2000, "接続拒否は待たずに即座に分かるべき");
});

test("probeHealth: TCP接続後に無応答でも有限時間で timeout として返す", async () => {
  // accept はするが一切書き込まない = 2026-09-07 の障害 (LISTEN のまま無応答) を模す。
  const srv = net.createServer((socket) => {
    socket.on("error", () => {});
    // 何も送らない・閉じない
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  try {
    const startedAt = Date.now();
    const result = await probeHealth({ host: "127.0.0.1", port, timeoutMs: 800 });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.reachable, false);
    assert.equal(result.error, "timeout");
    // 有限時間で終わること。ハングしていないことの直接的な証拠。
    assert.ok(elapsed < 3000, `timeoutMs を大きく超えて戻った: ${elapsed}ms`);
  } finally {
    srv.close();
  }
});

test("probeHealth: 単発の遅い応答でも 200 なら ok", async () => {
  const srv = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, 50);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  try {
    const result = await probeHealth({ host: "127.0.0.1", port, timeoutMs: 2000 });
    assert.equal(result.ok, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// ------------------------------------------------------------ pipelineOf
test("pipelineOf: 実際に処理中でなければ「進行中」を名乗らない (誤表示の再発防止)", () => {
  const task = { state: STATES.AWAITING_AI_REVIEW, revision_count: 0, max_revisions: 3, retry_after: null };

  const whenActive = pipelineOf(task, { isActive: true, paused: false });
  assert.equal(whenActive.note, "審査Claudeが確認しています");
  assert.equal(whenActive.steps[1].status, "active");

  // 実際に起きた誤表示: 一時停止中・審査プロセス未起動でも「確認しています」と出ていた
  const whenIdle = pipelineOf(task, { isActive: false, paused: false });
  assert.notEqual(whenIdle.note, "審査Claudeが確認しています");
  assert.equal(whenIdle.steps[1].status, "waiting");

  const whenPaused = pipelineOf(task, { isActive: false, paused: true });
  assert.match(whenPaused.note, /一時停止/);
  assert.equal(whenPaused.steps[1].status, "paused");
});

test("pipelineOf: running でも isActive=false なら「作業しています」と言わない", () => {
  const task = { state: STATES.RUNNING, revision_count: 0, max_revisions: 3 };
  const active = pipelineOf(task, { isActive: true, paused: false });
  assert.equal(active.note, "実装Claudeが作業しています");
  const idle = pipelineOf(task, { isActive: false, paused: false });
  assert.notEqual(idle.note, "実装Claudeが作業しています");
});

test("pipelineOf: 終端状態は isActive/paused に関わらず完了扱い", () => {
  const task = { state: STATES.COMPLETED, revision_count: 0, max_revisions: 3 };
  const result = pipelineOf(task, { isActive: false, paused: true });
  assert.ok(result.steps.every((s) => s.status === "done" || s.status === "todo"));
});

// ------------------------------------------------------- Orchestrator
test("Orchestrator.tick: 審査だけを再開するときも currentTaskId を立てる (審査プロセスの実在を判定可能にする)", async () => {
  const h = await buildHarness();
  try {
    const { task } = h.repo.createTask({
      title: "審査再開のテスト",
      instruction: "何かしてください",
      source: "system",
      repoPath: h.config.repoPath,
      maxAttempts: 3,
      maxRevisions: 3,
    });
    // 「recovery 後」のような、既に awaiting_ai_review にいる状態を直接作る
    for (const st of [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING]) {
      h.repo.setState(task.id, st, "seed", "system");
    }
    const reportId = h.repo.saveReport(task.id, 1, makeReport(task.id), true);
    h.repo.setState(task.id, STATES.AWAITING_AI_REVIEW, "seed", "system", { report_id: reportId });

    let observedDuringReview = null;
    h.reviewEngine.setDefault({
      kind: "review",
      get review() {
        observedDuringReview = h.orchestrator.currentTaskId;
        return makeReview("accept_and_continue");
      },
    });

    assert.equal(h.orchestrator.currentTaskId, null);
    const worked = await h.orchestrator.tick();
    assert.equal(worked, true);
    assert.equal(observedDuringReview, task.id, "審査エンジン呼び出し中は currentTaskId が立っているべき");
    assert.equal(h.orchestrator.currentTaskId, null, "tick 終了後は currentTaskId が戻る");
    // 証拠 (実際の git 差分) を伴わない合成 fixture なので証拠ゲートには通らないが、
    // ここで見たいのは「審査が実際に呼ばれ、状態が動いたか」であって最終判定ではない。
    assert.notEqual(h.repo.getTask(task.id).state, STATES.AWAITING_AI_REVIEW);
  } finally {
    h.cleanup();
  }
});

test("Orchestrator.tick: 呼ばれるたびに lastTickAt が進む（ループの生存確認に使う）", async () => {
  const h = await buildHarness();
  try {
    assert.equal(h.orchestrator.lastTickAt, null);
    await h.orchestrator.tick();
    assert.ok(h.orchestrator.lastTickAt);
    const first = h.orchestrator.lastTickAt;
    await new Promise((r) => setTimeout(r, 5));
    await h.orchestrator.tick();
    assert.ok(h.orchestrator.lastTickAt >= first);
  } finally {
    h.cleanup();
  }
});

// -------------------------------------------------------------- Dashboard
async function buildDashboardHarness() {
  const h = await buildHarness();
  const intake = new DocumentIntake({ config: h.config, paths: h.paths, repo: h.repo, logger: h.logger });
  const diagnostics = new Diagnostics({ config: h.config, paths: h.paths, repo: h.repo, logger: h.logger });
  const dashboard = new Dashboard({
    config: h.config,
    paths: h.paths,
    repo: h.repo,
    logger: h.logger,
    orchestrator: h.orchestrator,
    todoManager: h.todoManager,
    intake,
    diagnostics,
  });
  const port = await freePort();
  dashboard.config = { ...h.config, dashboard: { ...h.config.dashboard, port, enabled: true } };
  await dashboard.start();
  h.dashboard = dashboard;
  h.port = port;
  const cleanup = h.cleanup.bind(h);
  h.cleanup = async () => {
    await dashboard.stop();
    cleanup();
  };
  return h;
}

test("GET /api/health: DB を伴わず、有限時間で ok:true を返す", async () => {
  const h = await buildDashboardHarness();
  try {
    const result = await probeHealth({ host: "127.0.0.1", port: h.port, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.body.ok, true);
    assert.equal(typeof result.body.pid, "number");
    assert.equal(result.body.paused, false);
  } finally {
    await h.cleanup();
  }
});

test("GET /api/home: 一時停止中は status.key が paused になり、作業中とは表示しない", async () => {
  const h = await buildDashboardHarness();
  try {
    // DB 上は「審査待ち」のタスクが残っているが、キューは一時停止中で
    // 実際にはどのプロセスもそれを処理していない (実際に起きた誤表示の再現)。
    const { task } = h.repo.createTask({
      title: "一時停止中に残った審査待ち",
      instruction: "i",
      source: "system",
      repoPath: h.config.repoPath,
      maxAttempts: 3,
      maxRevisions: 3,
    });
    for (const st of [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING, STATES.AWAITING_AI_REVIEW]) {
      h.repo.setState(task.id, st, "seed", "system");
    }
    h.orchestrator.pause();

    const res = await fetch(`http://127.0.0.1:${h.port}/api/home`);
    const body = await res.json();
    assert.equal(body.status.key, "paused");
    assert.equal(body.currentTaskActive, false);
    assert.notEqual(body.pipeline.note, "審査Claudeが確認しています");
  } finally {
    await h.cleanup();
  }
});

for (const [label, payload] of [['invalid JSON', 'oops'], ['false string', '{"ok":"false"}'], ['missing ok', '{}'], ['oversized', 'x'.repeat(70000)]]) {
  test(`probeHealth: rejects ${label}`, async () => {
    const srv = http.createServer((_req, res) => res.end(payload));
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    try {
      const result = await probeHealth({ host: '0.0.0.0', port: srv.address().port, timeoutMs: 1000 });
      assert.equal(result.ok, false);
      assert.equal(result.reachable, true);
      assert.equal(result.error, label === 'oversized' ? 'response too large' : 'invalid health response');
    } finally {
      srv.closeAllConnections();
      await new Promise(resolve => srv.close(resolve));
    }
  });
}

test('probeHealth: invalid timeout is rejected without opening a socket', async () => {
  for (const timeoutMs of [-1, 0, NaN, Infinity, 2147483648]) {
    const result = await probeHealth({ host: '127.0.0.1', port: 1, timeoutMs });
    assert.equal(result.error, 'invalid timeout');
  }
});

test('probeHealth: continuous partial response still reaches the hard deadline', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeHealth({ host: '127.0.0.1', port: srv.address().port, timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.ok(result.latencyMs < 2000);
  } finally {
    srv.closeAllConnections();
    await new Promise(resolve => srv.close(resolve));
  }
});

test('GET /api/home: pause during active work shows it is still running', async () => {
  const h = await buildDashboardHarness();
  try {
    const { task } = h.repo.createTask({ title: 'active', instruction: 'i', source: 'system', repoPath: h.config.repoPath });
    for (const state of [STATES.PREFLIGHT, STATES.RUNNING]) h.repo.setState(task.id, state, 'seed', 'system');
    h.orchestrator.currentTaskId = task.id;
    h.orchestrator.pause();
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/home`)).json();
    assert.equal(body.status.key, 'running');
    assert.equal(body.currentTaskActive, true);
    assert.equal(body.pipeline.steps[0].status, 'active');
    assert.match(body.status.detail, /続行/);
    assert.match(body.pipeline.note, /次の作業/);
  } finally {
    await h.cleanup();
  }
});
