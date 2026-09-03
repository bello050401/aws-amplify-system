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
  h.commitSomething = (fileName = `change-${Date.now()}.txt`) => {
    fs.writeFileSync(path.join(repoPath, fileName), "changed\n");
    spawnSync("git", ["add", "-A"], { cwd: repoPath });
    spawnSync("git", ["commit", "-q", "-m", "claude change"], { cwd: repoPath });
    return fileName;
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
      effect: () => { changed = h.commitSomething(); },
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
      effect: () => { changed = h.commitSomething(); },
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
      effect: () => { changed = h.commitSomething(); },
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
      effect: () => { changed = h.commitSomething(); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.script = [{ kind: "unavailable", reason: "api_failure", message: "500" }];
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

test("シナリオ8b: APIキー未設定でもシステムは止まらずTODOを出す", async () => {
  const h = await harnessWithRepo();
  try {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const task = addTask(h);
    let changed = null;
    h.runner.setDefault({
      kind: "success",
      effect: () => { changed = h.commitSomething(); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.script = [{ kind: "unavailable", reason: "no_api_key", message: "キーがありません" }];

    await h.orchestrator.tick();
    const after = h.repo.getTask(task.id);
    assert.equal(after.state, STATES.AWAITING_AI_REVIEW);
    assert.ok(h.repo.listTodos({ status: "open" }).some((t) => t.title.includes("OpenAI API キー")));

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
      effect: () => { changed = h.commitSomething(); },
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
      effect: () => { changed = h.commitSomething(); },
      get report() { return makeReport(task.id, { changes: [{ path: changed, purpose: "変更" }] }); },
    });
    h.reviewEngine.setDefault({ kind: "unavailable", reason: "no_api_key", message: "キーがありません" });

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
