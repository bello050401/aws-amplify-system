/**
 * 統合テスト (指示書 §14-2)。
 * 実 Claude / 実 OpenAI は呼ばない。fake runner と fake review engine を使う。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { STATES } from "../src/core/states.mjs";
import { makeReport } from "../src/runner/fakeRunner.mjs";
import { makeReview } from "../src/review/fakeReview.mjs";
import { Orchestrator } from "../src/core/orchestrator.mjs";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { TodoManager } from "../src/todo/todoManager.mjs";
import { FakeClaudeRunner } from "../src/runner/fakeRunner.mjs";
import { FakeReviewEngine } from "../src/review/fakeReview.mjs";
import { Logger } from "../src/log/logger.mjs";
import * as git from "../src/core/git.mjs";
import { buildHarness, initRepo, makeDocx, tempDir } from "./helpers.mjs";

/** git リポジトリを伴う harness。Claude が変更したことにする用のヘルパー付き。 */
async function harnessWithRepo(overrides = {}) {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const h = await buildHarness({ repoPath, ...overrides });
  h.repoPath = repoPath;
  /**
   * 実装担当がファイルを作ってコミットしたことにする。
   * 既定ではタスクの作業場所 (worktree) で行う。本体リポジトリで行いたい場合は
   * dir を明示する（別セッションの変更を模すときに使う）。
   *
   * 明示パスで add する。git add -A は gitGuard が禁止しており、
   * テストでも本番と同じ作法にそろえる。
   */
  h.commitSomething = (fileName = `change-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`, dir = repoPath) => {
    fs.writeFileSync(path.join(dir, fileName), "changed\n");
    spawnSync("git", ["add", "--", fileName], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "claude change"], { cwd: dir });
    return fileName;
  };
  /** タスクの作業場所（worktree があればそこ）。 */
  h.workDirOf = (taskId) => {
    const t = h.repo.getTask(taskId);
    return t?.work_dir || repoPath;
  };
  return h;
}

function addTask(h, title = "テストタスク", instruction = "何かしてください") {
  return h.repo.createTask({
    title,
    instruction,
    source: "user_ui",
    repoPath: h.config.repoPath,
    maxAttempts: h.config.queue.maxAttempts,
    maxRevisions: h.config.review.maxRevisions,
  }).task;
}

// 1) 登録 → Claude 成功 → 審査合格 → 完了
test("シナリオ1: 登録→Claude成功→審査合格→完了", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    // 実 Claude と同じく「実行中に」リポジトリが変わるようにする
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    assert.equal(await h.orchestrator.tick(), true);
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.COMPLETED, after.blocked_reason ?? "");
    assert.equal(h.runner.calls.length, 1);
    assert.equal(h.reviewEngine.calls.length, 1);
    const history = h.repo.history(task.id).map((r) => r.to_state);
    assert.deepEqual(history, [
      STATES.QUEUED,
      STATES.PREFLIGHT,
      STATES.RUNNING,
      STATES.VERIFYING,
      STATES.AWAITING_AI_REVIEW,
      STATES.COMPLETED,
    ]);
  } finally {
    h.cleanup();
  }
});

// 2) 部分完了 → 修正指示 → 再実行 → 完了
test("シナリオ2: 修正指示で再実行し完了する", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.script = [
      { kind: "review", review: makeReview("revision_required") },
      { kind: "review", review: makeReview("accept_and_continue") },
    ];

    await h.orchestrator.tick();
    let after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.QUEUED, "修正指示で再度キューに戻る");
    assert.equal(after.revision_count, 1);
    assert.ok(after.blocked_reason, "次回の指示が保存されている");

    await h.orchestrator.tick();
    after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.COMPLETED, after.blocked_reason ?? "");
    assert.equal(h.runner.calls.length, 2);
    assert.ok(h.runner.calls[1].instruction.includes("前回の審査からの修正指示"));
  } finally {
    h.cleanup();
  }
});

// 3) 本人操作検出 → TODO 生成 → 完了チェック → 再開
test("シナリオ3: 本人操作をTODO化し、完了で再開する", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      report: makeReport(task.id, {
        status: "blocked",
        changes: [],
        userActions: [
          {
            category: "oauth",
            title: "BASE の OAuth を承認してください",
            reason: "トークンが失効しています",
            steps: ["管理画面を開く", "再接続する"],
            completionCondition: "接続済みと表示されること",
            canUseIPhone: false,
            estimatedMinutes: 5,
          },
        ],
      }),
    });
    h.reviewEngine.setDefault({
      kind: "review",
      review: makeReview("request_user_action", { reason: "本人操作が必要です" }),
    });

    await h.orchestrator.tick();
    let after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_USER);

    const todos = h.repo.listTodos({ status: "open" });
    const oauth = todos.find((t) => t.category === "oauth");
    assert.ok(oauth, "OAuth の TODO が作られている");
    assert.equal(oauth.canUseIphone, false);
    assert.deepEqual(oauth.waitingTaskIds, [task.id]);

    const result = h.todoManager.complete(oauth.id);
    assert.deepEqual(result.resumedTaskIds, [task.id]);
    after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.QUEUED, "TODO 完了で自動再開する");
  } finally {
    h.cleanup();
  }
});

// 4) Word 投入 → 安定待ち → 抽出 → タスク生成 → 処理済み移動
test("シナリオ4: Word投入から抽出・タスク生成・processed 移動まで", async () => {
  const h = await harnessWithRepo();
  try {
    const file = path.join(h.paths.inboxDir, "要望書.docx");
    fs.writeFileSync(
      file,
      makeDocx({
        headings: [{ level: 1, text: "検索を速くしたい" }],
        paragraphs: ["在庫一覧の検索が遅いので改善したい。"],
      }),
    );

    const handled = await h.intake.scanInbox();
    assert.equal(handled, 1);
    assert.equal(fs.existsSync(file), false, "inbox から移動している");

    const docs = h.repo.listDocuments();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].parse_state, "extracted");
    assert.ok(fs.existsSync(docs[0].stored_path), "processed に元ファイルが残っている");
    assert.ok(docs[0].stored_path.includes("processed"));

    const { task, created } = h.intake.convertToTask(docs[0].id);
    assert.equal(created, true);
    assert.equal(task.title, "検索を速くしたい");
    assert.equal(task.source, "user_document");
    assert.equal(h.repo.getDocument(docs[0].id).parse_state, "converted");
  } finally {
    h.cleanup();
  }
});

// 5) 同一 Word 再投入 → 重複排除
test("シナリオ5: 同じWordを再投入しても二重登録しない", async () => {
  const h = await harnessWithRepo();
  try {
    const content = makeDocx({ paragraphs: ["同じ内容の文書"] });
    fs.writeFileSync(path.join(h.paths.inboxDir, "a.docx"), content);
    await h.intake.scanInbox();
    fs.writeFileSync(path.join(h.paths.inboxDir, "b.docx"), content);
    await h.intake.scanInbox();

    assert.equal(h.repo.listDocuments().length, 1, "SHA-256 が同じなので 1 件のまま");
    const audit = h.repo.listAudit().map((a) => a.action);
    assert.ok(audit.includes("document.duplicate"));
  } finally {
    h.cleanup();
  }
});

test("シナリオ5b: 書き込み途中とOffice一時ファイルを掴まない", async () => {
  const h = await harnessWithRepo();
  try {
    fs.writeFileSync(path.join(h.paths.inboxDir, "~$draft.docx"), makeDocx({ paragraphs: ["一時"] }));
    const handled = await h.intake.scanInbox();
    assert.equal(handled, 0, "~$ ファイルは処理しない");
    assert.equal(h.repo.listDocuments().length, 0);
    assert.ok(fs.existsSync(path.join(h.paths.inboxDir, "~$draft.docx")), "元ファイルは消さない");
  } finally {
    h.cleanup();
  }
});

// 6) Claude プロセス異常終了 → 再試行
test("シナリオ6: Claude異常終了で再試行し、上限で失敗にする", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.script = [
      { kind: "crash", exitCode: 1, error: "一度目の異常終了" },
      { kind: "crash", exitCode: 1, error: "二度目の別エラー" },
    ];
    h.runner.setDefault({ kind: "crash", exitCode: 1, error: "既定の異常終了" });

    await h.orchestrator.tick();
    let after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.RETRY_WAIT, "1 回目は再試行待ち");
    assert.equal(after.attempts, 1);

    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    await h.orchestrator.tick();
    after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.FAILED, "上限で失敗にする");
    assert.equal(after.attempts, 2);

    const todos = h.repo.listTodos({ status: "open" });
    assert.ok(todos.some((t) => t.title.includes("タスクが失敗")), "失敗時に TODO を作る");
  } finally {
    h.cleanup();
  }
});

test("シナリオ6b: 同じ失敗が続いたら上限前でも止める", async () => {
  const h = await harnessWithRepo({ queue: { maxAttempts: 5, retryBaseSeconds: 0, retryMaxSeconds: 0, heartbeatWarnSeconds: 900, pollIntervalSeconds: 1 } });
  try {
    const task = addTask(h);
    h.runner.setDefault({ kind: "crash", exitCode: 1, error: "同じエラー" });

    await h.orchestrator.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.RETRY_WAIT);
    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    await h.orchestrator.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.FAILED, "同一シグネチャの連続で無限ループを止める");
  } finally {
    h.cleanup();
  }
});

test("シナリオ6c: スキーマ違反の完了報告は合格にしない", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault({ kind: "invalid_report" });
    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);
    assert.notEqual(after.state, STATES.COMPLETED);
    assert.equal(h.reviewEngine.calls.length, 0, "スキーマ違反なら審査へ送らない");
  } finally {
    h.cleanup();
  }
});

// 7) Orchestrator 強制終了 → 再起動 → 状態復旧
test("シナリオ7: Orchestrator強制終了後に状態を復旧する", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    // 「実行中に落ちた」状態を作る
    h.repo.setState(task.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(task.id, STATES.RUNNING, "x", "system");
    h.repo.updateTask(task.id, { attempts: 1 });

    // 新しい Orchestrator (= 再起動) を作って復旧させる
    const fresh = new Orchestrator({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      runner: new FakeClaudeRunner(),
      reviewEngine: new FakeReviewEngine(),
      todoManager: h.todoManager,
    });
    const recovered = await fresh.recover();
    assert.equal(recovered, 1);

    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.RETRY_WAIT, "running のまま放置しない");
    const checkpoint = h.repo.latestCheckpoint(task.id);
    assert.equal(checkpoint.phase, "recovery");
    assert.ok(h.repo.listAudit().some((a) => a.action === "task.recovered"));
  } finally {
    h.cleanup();
  }
});

test("シナリオ7b: 再試行上限に達したまま中断したらユーザー待ちにする", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.repo.setState(task.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(task.id, STATES.RUNNING, "x", "system");
    h.repo.updateTask(task.id, { attempts: h.config.queue.maxAttempts });

    await h.orchestrator.recover();
    assert.equal(h.repo.getTask(task.id).state, STATES.AWAITING_USER);
    assert.ok(h.repo.listTodos({ status: "open" }).length > 0);
  } finally {
    h.cleanup();
  }
});

// 8) OpenAI API 障害 → バックオフ → 復旧
test("シナリオ8: 審査API障害では状態を失わず、復旧後に流れる", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.script = [{ kind: "unavailable", reason: "transient", message: "500" }];
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();
    let after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "審査待ちのまま保持する");
    assert.ok(after.last_error);
    assert.ok(after.retry_after, "バックオフ時刻が入る (すぐ再試行して空転しない)");

    // バックオフ中は掴まない
    assert.equal(await h.orchestrator.tick(), false, "バックオフ中は審査を呼び直さない");

    // 時刻が来て API も復旧していれば審査が流れる
    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    await h.orchestrator.tick();
    after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.COMPLETED);
  } finally {
    h.cleanup();
  }
});

test("シナリオ8b: 審査に必要な設定が無くてもシステムは止まらず状態を保存する", async () => {
  const h = await harnessWithRepo();
  try {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.script = [{ kind: "unavailable", reason: "not_configured", message: "審査方式に必要な設定がありません" }];

    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "状態は保存されたまま");
    assert.ok(after.retry_after, "再確認の時刻が入る");

    const todos = h.repo.listTodos({ status: "open" });
    assert.ok(
      todos.some((t) => t.kind === "review_failure"),
      "審査できないことを知らせる TODO を出す",
    );
    assert.ok(
      !todos.some((t) => t.title.includes("OpenAI API キーを設定する")),
      "OPENAI_API_KEY 未設定そのものを TODO にはしない",
    );

    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  } finally {
    h.cleanup();
  }
});

// 9) 連続失敗 → 自動修正の上限 → TODO 生成
test("シナリオ9: 自動修正の無限ループを止めてTODOを出す", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault({ kind: "success", report: makeReport(task.id, { changes: [] }) });
    // 毎回別の理由で revision_required を返す (同一シグネチャ判定を避け、回数上限で止まることを見る)
    let n = 0;
    h.reviewEngine.review = async () => {
      n += 1;
      return {
        review: makeReview("revision_required", { reason: `理由 ${n}` }),
        meta: { model: "fake", promptVersion: "v1", usage: null, provider: "fake", attempts: 1 },
      };
    };

    for (let i = 0; i < 6; i += 1) {
      h.repo.releaseDueRetries();
      const worked = await h.orchestrator.tick();
      if (!worked) break;
      const state = h.repo.getTask(task.id).state;
      if (state === STATES.AWAITING_USER || state === STATES.FAILED) break;
    }

    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_USER, `状態: ${after.state}`);
    assert.ok(after.revision_count <= h.config.review.maxRevisions + 1);
    assert.ok(
      h.repo.listTodos({ status: "open" }).some((t) => t.title.includes("自動修正が収束しません")),
      "収束しないことを TODO で知らせる",
    );
  } finally {
    h.cleanup();
  }
});

test("シナリオ9b: 証拠ゲートが落ちればAIのacceptを採用しない", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    // テスト未実行の報告 = 証拠ゲート不合格
    h.runner.setDefault({ kind: "success", report: makeReport(task.id, { tests: [], changes: [] }) });
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);
    assert.notEqual(after.state, STATES.COMPLETED, "AI が accept でも証拠がなければ完了にしない");
    assert.ok(h.repo.listAudit().some((a) => a.action === "review.override"));
  } finally {
    h.cleanup();
  }
});

test("シナリオ9c: 低い確信度はレビュー待ちにする", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.setDefault({
      kind: "review",
      review: makeReview("accept_and_continue", { confidence: 0.2 }),
    });

    await h.orchestrator.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.PAUSED);
  } finally {
    h.cleanup();
  }
});

// 10) dirty worktree があっても既存変更を破壊しない
test("シナリオ10: 作業開始前のユーザー変更を自動コミットに巻き込まない", async () => {
  const h = await harnessWithRepo({ git: { autoCommit: true, allowPush: false, protectedBranches: ["main"] } });
  try {
    // main 以外のブランチにする (保護ブランチでは自動コミットしない)
    spawnSync("git", ["checkout", "-q", "-b", "work"], { cwd: h.repoPath });

    // ユーザーの未コミット変更
    const userFile = path.join(h.repoPath, "user-work.txt");
    fs.writeFileSync(userFile, "ユーザーが編集中\n");

    const snapshot = git.snapshotWorkingTree(h.repoPath);
    assert.equal(snapshot.dirty, true);

    // Claude の変更
    fs.writeFileSync(path.join(h.repoPath, "claude-change.txt"), "claude\n");

    const result = git.commitTaskChanges({
      repoPath: h.repoPath,
      branch: "work",
      message: "test commit",
      snapshot,
      protectedBranches: ["main"],
    });

    assert.equal(result.committed, true, result.reason);
    assert.deepEqual(result.files, ["claude-change.txt"]);
    assert.ok(result.skipped.some((s) => s.file === "user-work.txt"));

    // ユーザーの変更は未コミットのまま、内容も無事
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: h.repoPath, encoding: "utf8" }).stdout;
    assert.ok(status.includes("user-work.txt"), "ユーザーの変更は未コミットのまま残る");
    assert.equal(fs.readFileSync(userFile, "utf8"), "ユーザーが編集中\n");
  } finally {
    h.cleanup();
  }
});

test("シナリオ10b: 保護ブランチでは自動コミットしない", async () => {
  const h = await harnessWithRepo();
  try {
    const branch = git.currentBranch(h.repoPath);
    fs.writeFileSync(path.join(h.repoPath, "x.txt"), "x\n");
    const snapshot = { entries: [], branch, headCommit: git.headCommit(h.repoPath) };
    const result = git.commitTaskChanges({
      repoPath: h.repoPath,
      branch,
      message: "should not happen",
      snapshot,
      protectedBranches: [branch],
    });
    assert.equal(result.committed, false);
    assert.ok(result.reason.includes("保護ブランチ"));
  } finally {
    h.cleanup();
  }
});

test("シナリオ10c: .env や DB はコミット対象に含めない", async () => {
  const h = await harnessWithRepo();
  try {
    spawnSync("git", ["checkout", "-q", "-b", "work2"], { cwd: h.repoPath });
    fs.writeFileSync(path.join(h.repoPath, ".env"), "OPENAI_API_KEY=should-not-be-committed\n");
    fs.writeFileSync(path.join(h.repoPath, "orchestrator.db"), "binary");
    fs.writeFileSync(path.join(h.repoPath, "real-change.ts"), "export const a = 1;\n");

    const snapshot = { entries: [], branch: "work2", headCommit: git.headCommit(h.repoPath) };
    const result = git.commitTaskChanges({
      repoPath: h.repoPath,
      branch: "work2",
      message: "test",
      snapshot,
      protectedBranches: ["main"],
    });
    assert.equal(result.committed, true, result.reason);
    assert.deepEqual(result.files, ["real-change.ts"]);
    assert.ok(result.skipped.some((s) => s.file === ".env"));
    assert.ok(result.skipped.some((s) => s.file === "orchestrator.db"));
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------- 一時停止と手動停止
test("一時停止中はタスクを開始しない", async () => {
  const h = await harnessWithRepo();
  try {
    addTask(h);
    h.orchestrator.pause();
    assert.equal(await h.orchestrator.tick(), false);
    h.orchestrator.resume();
    assert.equal(await h.orchestrator.tick(), true);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------- 審査不能時にループが空転しないこと
test("審査不能時: 同じタスクを掴み続けてループが空転しない", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.setDefault({ kind: "unavailable", reason: "not_configured", message: "審査方式に必要な設定がありません" });

    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW);
    assert.ok(after.retry_after, "次に見る時刻が入っている");
    assert.ok(new Date(after.retry_after).getTime() > Date.now(), "未来の時刻である");

    const reviewCallsBefore = h.reviewEngine.calls.length;
    // 直後の tick では掴まない = 空転しない
    assert.equal(await h.orchestrator.tick(), false, "すぐに再試行しない");
    assert.equal(h.reviewEngine.calls.length, reviewCallsBefore, "審査を呼び直していない");

    // 時刻が来れば再び審査へ進む
    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });
    assert.equal(await h.orchestrator.tick(), true);
    assert.equal(h.repo.getTask(task.id).state, STATES.COMPLETED);
    assert.equal(h.repo.getTask(task.id).retry_after, null, "成功したら待機指示を消す");
  } finally {
    h.cleanup();
  }
});

test("シナリオ7c: 審査待ちのタスクは復旧で作り直さない（成功した Claude 実行を捨てない）", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(undefined, h.workDirOf(task.id)); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.setDefault({ kind: "unavailable", reason: "not_configured", message: "審査方式に必要な設定がありません" });

    await h.orchestrator.tick();
    const beforeReport = h.repo.getTask(task.id).report_id;
    assert.equal(h.repo.getTask(task.id).state, STATES.AWAITING_AI_REVIEW);
    assert.ok(beforeReport, "完了報告が保存されている");
    const runsBefore = h.runner.calls.length;

    // 再起動相当
    const fresh = new Orchestrator({
      config: h.config, paths: h.paths, repo: h.repo, logger: h.logger,
      runner: h.runner, reviewEngine: h.reviewEngine, todoManager: h.todoManager,
    });
    await fresh.recover();

    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "審査待ちのまま");
    assert.equal(after.report_id, beforeReport, "完了報告を失わない");
    assert.equal(after.retry_after, null, "起動直後に審査へ進めるよう待機指示は消す");

    // キーが復活すれば Claude を走らせ直さずに完了する
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });
    await fresh.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.COMPLETED);
    assert.equal(h.runner.calls.length, runsBefore, "Claude を再実行していない");
  } finally {
    h.cleanup();
  }
});

test("シナリオ7d: 検証中に落ちたら、完了報告があれば審査から再開する", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.repo.setState(task.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(task.id, STATES.RUNNING, "x", "system");
    h.repo.setState(task.id, STATES.VERIFYING, "x", "system");
    const reportId = h.repo.saveReport(task.id, 1, makeReport(task.id), true);
    h.repo.updateTask(task.id, { report_id: reportId });

    await h.orchestrator.recover();
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "Claude を走らせ直さない");
    assert.equal(after.report_id, reportId);
  } finally {
    h.cleanup();
  }
});

test("シナリオ7e: 検証中で完了報告が無ければ再実行に回す", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.repo.setState(task.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(task.id, STATES.RUNNING, "x", "system");
    h.repo.setState(task.id, STATES.VERIFYING, "x", "system");

    await h.orchestrator.recover();
    assert.equal(h.repo.getTask(task.id).state, STATES.RETRY_WAIT);
  } finally {
    h.cleanup();
  }
});

// ==================================================== 審査方式の切り替え
/** 審査エンジンを注入せず、方式の選択が効く Orchestrator を作る。 */
function orchestratorWithProviders(h, reviewEngines = {}) {
  return new Orchestrator({
    config: h.config,
    paths: h.paths,
    repo: h.repo,
    logger: h.logger,
    runner: h.runner,
    reviewEngines,
    todoManager: h.todoManager,
  });
}

/**
 * 実行中にコミットする実装担当の振る舞い。実 Claude と同じ順序を再現する。
 * コミット先は「そのタスクの作業場所」。worktree 方式ならその中で完結する。
 */
function committingRunner(h, task, overrides = {}) {
  let changed = null;
  return {
    kind: "success",
    effect: () => {
      changed = h.commitSomething(undefined, h.workDirOf(task.id));
    },
    get report() {
      return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }], ...overrides });
    },
  };
}

test("手動審査: 合格と回答すると完了する（AI を一切呼ばない）", async () => {
  const h = await harnessWithRepo();
  try {
    h.repo.setReviewProvider("manual");
    const orch = orchestratorWithProviders(h);

    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));

    await orch.tick();
    let after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "審査待ちで保持する");

    const todo = h.repo.listTodos({ status: "open" }).find((t) => t.kind === "manual_review");
    assert.ok(todo, "手動審査の TODO が作られる");
    assert.ok(todo.reason.includes("証拠ゲート"), "機械的な証拠も一緒に見せる");
    assert.equal(todo.answerRequired, true, "チェックだけで完了させない");

    assert.equal(await orch.tick(), false, "判定待ちのタスクは掴まない");
    assert.equal(h.repo.listTodos({ status: "open" }).filter((t) => t.kind === "manual_review").length, 1);

    const result = h.todoManager.complete(todo.id, { answer: "合格" });
    assert.equal(result.manualReview.decision, "accept_and_continue");
    after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.COMPLETED);

    const reviews = h.repo.reviewsFor(task.id);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].provider, "manual");
    assert.equal(reviews[0].decision, "accept_and_continue");
  } finally {
    h.cleanup();
  }
});

test("手動審査: 修正内容を書くと、そのまま実装担当への指示になる", async () => {
  const h = await harnessWithRepo();
  try {
    h.repo.setReviewProvider("manual");
    const orch = orchestratorWithProviders(h);
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));

    await orch.tick();
    const todo = h.repo.listTodos({ status: "open" }).find((t) => t.kind === "manual_review");
    h.todoManager.complete(todo.id, { answer: "E2E テストを追加してください" });

    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.QUEUED, "修正のため再実行キューへ戻る");
    assert.equal(after.revision_count, 1);
    assert.ok(after.blocked_reason.includes("E2E テストを追加"), "回答が修正指示になる");

    await orch.tick();
    assert.ok(h.runner.calls[1].instruction.includes("E2E テストを追加してください"));
  } finally {
    h.cleanup();
  }
});

test("手動審査: 証拠ゲートが落ちていれば「合格」と打っても完了にしない", async () => {
  const h = await harnessWithRepo();
  try {
    h.repo.setReviewProvider("manual");
    const orch = orchestratorWithProviders(h);
    const task = addTask(h);
    h.runner.setDefault({ kind: "success", report: makeReport(task.id, { tests: [], changes: [] }) });

    await orch.tick();
    const todo = h.repo.listTodos({ status: "open" }).find((t) => t.kind === "manual_review");
    assert.equal(todo.priority, "urgent", "証拠が足りない場合は緊急にする");
    h.todoManager.complete(todo.id, { answer: "合格" });

    const after = h.repo.getTask(task.id);
    assert.notEqual(after.state, STATES.COMPLETED, "人が合格と言っても証拠が無ければ通さない");
    assert.ok(h.repo.listAudit().some((a) => a.action === "review.override"));
  } finally {
    h.cleanup();
  }
});

test("審査方式: 使えない方式を選んでも状態を保存して TODO を出す（止まらない）", async () => {
  const h = await harnessWithRepo();
  try {
    h.repo.setReviewProvider("openai");
    const orch = orchestratorWithProviders(h, {});
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));

    await orch.tick();
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW, "状態は保存される");
    assert.equal(after.review_failures, 1);
    assert.ok(after.retry_after);
    assert.ok(h.repo.listTodos({ status: "open" }).some((t) => t.kind === "review_failure"));

    h.repo.setReviewProvider("claude");
    h.repo.updateTask(task.id, { retry_after: null });
    const orch2 = orchestratorWithProviders(h, { claude: new FakeReviewEngine() });
    await orch2.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.COMPLETED, "方式を変えれば再実行なしで完了できる");
    assert.equal(h.runner.calls.length, 1, "Claude を走らせ直していない");
  } finally {
    h.cleanup();
  }
});

test("利用上限・認証切れ: 初回から TODO を出し、状態は審査待ちのまま保つ", async () => {
  const cases = [
    ["usage_limit", "利用上限"],
    ["auth_expired", "ログインが切れて"],
  ];
  for (const [reason, expectTitle] of cases) {
    const h = await harnessWithRepo();
    try {
      const task = addTask(h);
      h.runner.setDefault(committingRunner(h, task));
      h.reviewEngine.setDefault({ kind: "unavailable", reason, message: "fake " + reason });

      await h.orchestrator.tick();
      const after = h.repo.getTask(task.id);
      assert.equal(after.state, STATES.AWAITING_AI_REVIEW, reason + ": 状態を保存する");
      assert.ok(after.retry_after, reason + ": 再確認の時刻が入る");
      assert.ok(after.last_error, reason + ": 理由を残す");

      const todos = h.repo.listTodos({ status: "open" });
      assert.ok(
        todos.some((t) => t.kind === "review_failure" && t.title.includes(expectTitle)),
        reason + ": 初回から TODO を出す",
      );
      const checkpoint = h.repo.store.get(
        "SELECT data FROM checkpoints WHERE task_id=? AND phase='review_failure' ORDER BY id DESC LIMIT 1",
        [task.id],
      );
      assert.ok(checkpoint, reason + ": チェックポイントを残す");
    } finally {
      h.cleanup();
    }
  }
});

test("審査が復旧したら、審査失敗の TODO は自動で閉じる", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    h.reviewEngine.script = [{ kind: "unavailable", reason: "usage_limit", message: "limit" }];
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();
    assert.ok(h.repo.listTodos({ status: "open" }).some((t) => t.kind === "review_failure"));

    h.repo.updateTask(task.id, { retry_after: null });
    await h.orchestrator.tick();
    assert.equal(h.repo.getTask(task.id).state, STATES.COMPLETED);
    assert.equal(h.repo.getTask(task.id).review_failures, 0, "失敗カウンタを戻す");
    assert.equal(
      h.repo.listTodos({ status: "open" }).filter((t) => t.kind === "review_failure").length,
      0,
      "解決済みの TODO を残さない",
    );
  } finally {
    h.cleanup();
  }
});

test("自動修正は最大 3 回で止まる（既定値）", async () => {
  const h = await harnessWithRepo({
    review: {
      provider: "claude",
      claude: { model: "sonnet", timeoutSeconds: 120, maxBudgetUsd: 1, allowedTools: [], disallowedTools: [] },
      model: "",
      maxRevisions: 3,
      requestTimeoutSeconds: 30,
      maxRetries: 1,
      baseBackoffSeconds: 0,
      maxBackoffSeconds: 0,
      maxDiffChars: 1000,
      minConfidenceToAccept: 0.5,
    },
    queue: { maxAttempts: 20, retryBaseSeconds: 0, retryMaxSeconds: 0, heartbeatWarnSeconds: 900, pollIntervalSeconds: 1 },
  });
  try {
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    let n = 0;
    h.reviewEngine.review = async () => {
      n += 1;
      return {
        review: makeReview("revision_required", { reason: "毎回ちがう理由 " + n }),
        meta: { model: "fake", promptVersion: "v1", usage: null, provider: "fake", attempts: 1 },
      };
    };

    for (let i = 0; i < 10; i += 1) {
      h.repo.releaseDueRetries();
      if (!(await h.orchestrator.tick())) break;
      const st = h.repo.getTask(task.id).state;
      if (st === STATES.AWAITING_USER || st === STATES.FAILED) break;
    }

    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_USER);
    assert.ok(after.revision_count > h.config.review.maxRevisions, "修正回数 " + after.revision_count);
    assert.equal(h.runner.calls.length, h.config.review.maxRevisions + 1, "実装は 1 回 + 修正 3 回 = 4 回まで");
  } finally {
    h.cleanup();
  }
});

// ================================================ Git の作業分離
import * as wt from "../src/core/worktree.mjs";
import { assertGitCommandAllowed, ForbiddenGitCommandError } from "../src/core/gitGuard.mjs";

test("Git ガード: 無差別ステージと破壊的コマンドを実行前に落とす", () => {
  const forbidden = [
    ["add", "-A"],
    ["add", "--all"],
    ["add", "."],
    ["add", "-u"],
    ["add"],
    ["commit", "-am", "x"],
    ["commit", "-a"],
    ["commit", "--amend"],
    ["reset", "--hard"],
    ["stash"],
    ["stash", "push"],
    ["clean", "-fd"],
    ["push", "origin", "main"],
    ["rebase", "main"],
    ["checkout", "--", "file.txt"],
    ["-C", "/somewhere", "add", "-A"],
  ];
  for (const args of forbidden) {
    assert.throws(() => assertGitCommandAllowed(args), ForbiddenGitCommandError, `許してはいけない: git ${args.join(" ")}`);
  }

  const allowed = [
    ["status", "--porcelain"],
    ["diff", "--name-only"],
    ["log", "--oneline", "-3"],
    ["add", "--", "a.txt", "b.txt"],
    ["add", "a.txt"],
    ["commit", "-m", "msg"],
    ["reset", "--", "a.txt"],
    ["worktree", "add", "/path", "-b", "br", "HEAD"],
    ["worktree", "remove", "/path"],
  ];
  for (const args of allowed) {
    assert.doesNotThrow(() => assertGitCommandAllowed(args), `通すべき: git ${args.join(" ")}`);
  }
});

test("Git ガード: runGit 経由でも禁止コマンドは実行されない", async () => {
  const gitmod = await import("../src/core/git.mjs");
  const res = gitmod.runGit(process.cwd(), ["add", "-A"]);
  assert.equal(res.ok, false);
  assert.equal(res.forbidden, true);
  assert.match(res.stderr, /禁止/);
});

test("分離1: タスクは専用 worktree と専用ブランチで動く", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);

    assert.equal(after.isolation, "worktree");
    assert.ok(after.worktree_path, "worktree の場所が記録される");
    assert.equal(after.worktree_branch, wt.branchNameFor(task.id));
    assert.ok(after.base_commit, "基準コミットが記録される");
    assert.ok(after.base_branch, "基準ブランチが記録される");
    assert.notEqual(after.work_dir, h.repoPath, "本体リポジトリでは作業しない");
    assert.ok(fs.existsSync(after.worktree_path), "worktree が実在する");

    // worktree はデータ置き場の下（リポジトリの外）
    assert.ok(after.worktree_path.startsWith(h.paths.worktreeRoot), "worktree はリポジトリの外に置く");

    // 成果はタスク専用ブランチに入り、本体ブランチは動かない
    const list = wt.listWorktrees(h.repoPath);
    assert.ok(list.some((w) => w.branch === after.worktree_branch), "worktree 一覧に出る");
  } finally {
    h.cleanup();
  }
});

test("分離2: 並行 2 タスクは互いのファイルを見ない", async () => {
  const h = await harnessWithRepo();
  try {
    const a = addTask(h, "タスクA", "A をやる");
    const b = addTask(h, "タスクB", "B をやる");

    const madeIn = {};
    h.runner.setDefault({
      kind: "success",
      effect: ({ task }) => {
        const dir = h.workDirOf(task.id);
        madeIn[task.id] = h.commitSomething(`only-${task.id}.txt`, dir);
      },
      get report() {
        return makeReport("placeholder");
      },
    });
    // report は taskId が要るので、実行のたびに作り直す
    h.runner.run = async function run({ task, onHeartbeat = () => {} }) {
      onHeartbeat();
      const dir = h.workDirOf(task.id);
      madeIn[task.id] = h.commitSomething(`only-${task.id}.txt`, dir);
      this.calls.push({ taskId: task.id, instruction: "", resumeSessionId: null, at: new Date().toISOString() });
      return {
        ok: true,
        terminationReason: "completed",
        exitCode: 0,
        durationMs: 5,
        report: makeReport(task.id, { changes: [{ path: madeIn[task.id], purpose: "変更" }] }),
        reportErrors: [],
        sessionId: `sess-${task.id}`,
      };
    };
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();
    await h.orchestrator.tick();

    const ta = h.repo.getTask(a.id);
    const tb = h.repo.getTask(b.id);
    assert.notEqual(ta.work_dir, tb.work_dir, "作業場所が別");
    assert.notEqual(ta.worktree_branch, tb.worktree_branch, "ブランチが別");

    // A の worktree に B のファイルは存在しない（その逆も）
    assert.ok(fs.existsSync(path.join(ta.work_dir, madeIn[a.id])));
    assert.ok(!fs.existsSync(path.join(ta.work_dir, madeIn[b.id])), "A の作業場所に B の成果は無い");
    assert.ok(fs.existsSync(path.join(tb.work_dir, madeIn[b.id])));
    assert.ok(!fs.existsSync(path.join(tb.work_dir, madeIn[a.id])), "B の作業場所に A の成果は無い");

    // それぞれの変更ファイル記録も混ざらない
    assert.deepEqual(ta.changedFiles, [madeIn[a.id]]);
    assert.deepEqual(tb.changedFiles, [madeIn[b.id]]);
  } finally {
    h.cleanup();
  }
});

test("分離3: 開始前から dirty でも、その変更には一切触れない", async () => {
  const h = await harnessWithRepo({ git: { autoCommit: true, allowPush: false, protectedBranches: ["main"], isolation: "worktree", allowInPlaceFallback: true, removeWorktreeWhenSafe: false } });
  try {
    spawnSync("git", ["checkout", "-q", "-b", "work"], { cwd: h.repoPath });

    // ユーザーの未コミット変更（追跡中の変更と、新規の未追跡ファイル）
    fs.writeFileSync(path.join(h.repoPath, "README.md"), "ユーザーが編集中\n");
    fs.writeFileSync(path.join(h.repoPath, "user-scratch.txt"), "ユーザーの作業メモ\n");
    const beforeStatus = spawnSync("git", ["status", "--porcelain"], { cwd: h.repoPath, encoding: "utf8" }).stdout;

    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();

    // 開始時点のスナップショットが記録されている
    const cp = h.repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase='preflight' ORDER BY id DESC LIMIT 1",
      [task.id],
    );
    const snap = JSON.parse(cp.data);
    assert.equal(snap.dirty, true);
    assert.ok(snap.entries.some((e) => e.includes("README.md")));
    assert.ok(snap.entries.some((e) => e.includes("user-scratch.txt")));

    // 本体リポジトリの未コミット変更は 1 バイトも変わっていない
    const afterStatus = spawnSync("git", ["status", "--porcelain"], { cwd: h.repoPath, encoding: "utf8" }).stdout;
    assert.equal(afterStatus, beforeStatus, "本体の未コミット変更が動いていない");
    assert.equal(fs.readFileSync(path.join(h.repoPath, "README.md"), "utf8"), "ユーザーが編集中\n");
    assert.equal(fs.readFileSync(path.join(h.repoPath, "user-scratch.txt"), "utf8"), "ユーザーの作業メモ\n");

    // タスクの成果には、ユーザーのファイルが一切含まれない
    const after = h.repo.getTask(task.id);
    assert.ok(!after.changedFiles.includes("README.md"));
    assert.ok(!after.changedFiles.includes("user-scratch.txt"));
  } finally {
    h.cleanup();
  }
});

test("分離4: 同じファイルを別セッションが触っていたら自動マージせず TODO にする", async () => {
  const h = await harnessWithRepo();
  try {
    spawnSync("git", ["checkout", "-q", "-b", "work"], { cwd: h.repoPath });
    const shared = "shared.txt";
    fs.writeFileSync(path.join(h.repoPath, shared), "もとの内容\n");
    spawnSync("git", ["add", "--", shared], { cwd: h.repoPath });
    spawnSync("git", ["commit", "-q", "-m", "add shared"], { cwd: h.repoPath });

    const task = addTask(h);
    h.runner.run = async function run({ task: t, onHeartbeat = () => {} }) {
      onHeartbeat();
      const dir = h.workDirOf(t.id);
      // タスクが shared.txt を変更する
      fs.writeFileSync(path.join(dir, shared), "タスクが直した内容\n");
      spawnSync("git", ["add", "--", shared], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "task change"], { cwd: dir });
      // 同じ頃、別セッションが本体側で同じファイルを触る
      fs.writeFileSync(path.join(h.repoPath, shared), "別セッションが直した内容\n");
      this.calls.push({ taskId: t.id, instruction: "", resumeSessionId: null, at: new Date().toISOString() });
      return {
        ok: true,
        terminationReason: "completed",
        exitCode: 0,
        durationMs: 5,
        report: makeReport(t.id, { changes: [{ path: shared, purpose: "変更" }] }),
        reportErrors: [],
        sessionId: "s",
      };
    };
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });

    await h.orchestrator.tick();

    const cp = h.repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase='conflict_check' ORDER BY id DESC LIMIT 1",
      [task.id],
    );
    assert.ok(cp, "競合検査の記録が残る");
    const conflict = JSON.parse(cp.data);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].file, shared);

    const todo = h.repo.listTodos({ status: "open" }).find((t) => t.kind === "merge_conflict");
    assert.ok(todo, "競合を知らせる TODO が出る");
    assert.equal(todo.priority, "urgent");
    assert.ok(todo.reason.includes(shared));
    assert.ok(h.repo.listAudit().some((a) => a.action === "conflict.detected"));

    // 自動マージしていない: 本体側の内容はそのまま
    assert.equal(fs.readFileSync(path.join(h.repoPath, shared), "utf8"), "別セッションが直した内容\n");
  } finally {
    h.cleanup();
  }
});

test("分離5: 異常終了しても worktree とブランチは消えず、復旧後も同じ場所を使う", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    h.reviewEngine.setDefault({ kind: "unavailable", reason: "transient", message: "後で" });

    await h.orchestrator.tick();
    const first = h.repo.getTask(task.id);
    const worktreePath = first.worktree_path;
    const branch = first.worktree_branch;
    assert.ok(fs.existsSync(worktreePath));

    // 「実行中に落ちた」状態を作って復旧させる
    h.repo.updateTask(task.id, { retry_after: null });
    h.repo.setState(task.id, STATES.REVISION_REQUIRED, "試験", "system");
    h.repo.setState(task.id, STATES.QUEUED, "試験", "system");
    h.repo.setState(task.id, STATES.PREFLIGHT, "試験", "system");
    h.repo.setState(task.id, STATES.RUNNING, "試験: 実行中に落ちた", "system");

    const fresh = new Orchestrator({
      config: h.config, paths: h.paths, repo: h.repo, logger: h.logger,
      runner: h.runner, reviewEngine: h.reviewEngine, todoManager: h.todoManager,
    });
    await fresh.recover();

    assert.ok(fs.existsSync(worktreePath), "復旧処理は worktree を消さない");
    const afterRecover = h.repo.getTask(task.id);
    assert.equal(afterRecover.worktree_path, worktreePath, "作業場所の記録が残る");
    assert.equal(afterRecover.worktree_branch, branch, "ブランチの記録が残る");

    // 再実行しても同じ worktree を引き継ぐ（成果を捨てない）
    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    h.repo.releaseDueRetries();
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });
    await fresh.tick();
    assert.equal(h.repo.getTask(task.id).worktree_path, worktreePath, "同じ作業場所を再利用する");
  } finally {
    h.cleanup();
  }
});

test("分離6: worktree の削除は安全確認を通ったときだけ", async () => {
  const h = await harnessWithRepo();
  try {
    const task = addTask(h);
    h.runner.setDefault(committingRunner(h, task));
    h.reviewEngine.setDefault({ kind: "review", review: makeReview("accept_and_continue") });
    await h.orchestrator.tick();

    const after = h.repo.getTask(task.id);

    // 未マージのコミットがあるので消せない
    const check = h.orchestrator.inspectWorkspace(task.id);
    assert.equal(check.removable, false);
    assert.ok(check.reasons.some((r) => r.includes("取り込まれていないコミット")));

    // 既定では削除しない（証拠として残す）
    const cleanup = h.orchestrator.cleanupWorkspace(task.id);
    assert.equal(cleanup.removed, false);
    assert.ok(fs.existsSync(after.worktree_path), "worktree は残る");

    // 未コミットの変更があるだけでも消せない
    fs.writeFileSync(path.join(after.worktree_path, "leftover.txt"), "まだ途中\n");
    const check2 = h.orchestrator.inspectWorkspace(task.id);
    assert.equal(check2.removable, false);
    assert.ok(check2.reasons.some((r) => r.includes("未コミットの変更")));
  } finally {
    h.cleanup();
  }
});

test("分離7: 自動コミットは証明できるファイルだけを stage する", async () => {
  const gitmod = await import("../src/core/git.mjs");
  const h = await harnessWithRepo();
  try {
    spawnSync("git", ["checkout", "-q", "-b", "work"], { cwd: h.repoPath });
    fs.writeFileSync(path.join(h.repoPath, "mine.txt"), "task\n");
    fs.writeFileSync(path.join(h.repoPath, "not-mine.txt"), "someone else\n");
    fs.writeFileSync(path.join(h.repoPath, ".env"), "OPENAI_API_KEY=secret\n");

    const result = gitmod.commitTaskChanges({
      repoPath: h.repoPath,
      branch: "work",
      message: "test",
      snapshot: { entries: [] },
      allowedFiles: ["mine.txt", ".env"], // .env は許可リストにあっても除外される
      protectedBranches: ["main"],
    });

    assert.equal(result.committed, true, result.reason);
    assert.deepEqual(result.files, ["mine.txt"]);
    assert.ok(result.skipped.some((s) => s.file === "not-mine.txt" && s.why.includes("証明できない")));
    assert.ok(result.skipped.some((s) => s.file === ".env" && s.why.includes("秘密")));

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: h.repoPath, encoding: "utf8" }).stdout;
    assert.ok(status.includes("not-mine.txt"), "他人のファイルは未コミットのまま");
    assert.ok(status.includes(".env"), ".env は未コミットのまま");
  } finally {
    h.cleanup();
  }
});
