/**
 * タスクごとの作業場所の分離。
 *
 * なぜ worktree か:
 *   同じ作業ツリーを、実装 Claude・審査 Claude・Remote Control セッション・
 *   ユーザー本人が同時に触ると、誰の変更か区別がつかなくなる。実際に
 *   2026-09-03、別セッションのコミットへ本システムの作業中ファイルが
 *   混入する事故が起きた。
 *
 *   タスクごとに専用 worktree を作ると、その worktree は「基準コミットの
 *   きれいな複製」から始まる。したがって **そこで dirty なファイルは、
 *   そのタスクが作ったものだけ** だと証明できる。開始前の未コミット変更は
 *   そもそも複製されないので、触りようがない。
 *
 * 置き場所:
 *   リポジトリの外（dataRoot 配下）に置く。リポジトリ内に置くと、本体側の
 *   git status や検索に混ざり、別セッションが巻き込む余地が残るため。
 */
import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git.mjs";

/** タスク ID からブランチ名を作る。既存の命名と衝突しない接頭辞にする。 */
export function branchNameFor(taskId) {
  return `bello/task/${String(taskId).replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

export function worktreePathFor(worktreeRoot, taskId) {
  return path.join(worktreeRoot, String(taskId).replace(/[^A-Za-z0-9_.-]/g, "-"));
}

/**
 * タスク用の worktree とブランチを作る。
 *
 * 基準は「いまの HEAD コミット」。作業ツリーの未コミット変更は持ち込まない。
 * これが「開始前から存在した未コミット変更を絶対に触らない」ことの担保になる。
 *
 * @returns {{ok:true, path:string, branch:string, baseCommit:string, baseBranch:string}
 *          | {ok:false, reason:string}}
 */
export function createTaskWorktree({ repoPath, worktreeRoot, taskId, logger }) {
  const branch = branchNameFor(taskId);
  const target = worktreePathFor(worktreeRoot, taskId);

  const head = runGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, reason: `HEAD を取得できません: ${head.stderr}` };
  const baseCommit = head.stdout;

  const branchNow = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch = branchNow.ok ? branchNow.stdout : null;

  // 既に同じ worktree があるなら作り直さない（復旧時に成果を失わないため）
  const existing = listWorktrees(repoPath).find((w) => samePath(w.path, target));
  if (existing) {
    logger?.info?.("既存の worktree を再利用します", { taskId, path: target, branch: existing.branch });
    return { ok: true, path: target, branch: existing.branch ?? branch, baseCommit, baseBranch, reused: true };
  }

  fs.mkdirSync(worktreeRoot, { recursive: true });

  // ブランチが残っている場合（前回の試行）は -b を付けずに再利用する
  const branchExists = runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const args = branchExists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", target, "-b", branch, baseCommit];

  const added = runGit(repoPath, args, { timeout: 120000 });
  if (!added.ok) {
    return { ok: false, reason: `worktree を作れません: ${added.stderr || added.stdout}` };
  }

  logger?.info?.("タスク専用の worktree を作りました", { taskId, path: target, branch, baseCommit });
  return { ok: true, path: target, branch, baseCommit, baseBranch, reused: false };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** `git worktree list --porcelain` を構造化する。 */
export function listWorktrees(repoPath) {
  const res = runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  const out = [];
  let current = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null, head: null, detached: false };
    } else if (line.startsWith("HEAD ")) {
      if (current) current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      if (current) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      if (current) current.detached = true;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * worktree を消してよいかを判定する。
 * 「未コミットの成果がない」「ブランチのコミットが基準ブランチに入っている」の
 * 両方が満たされたときだけ true。片方でも欠ければ消さない。
 */
export function canRemoveWorktree({ repoPath, worktreePath, branch, baseBranch }) {
  const reasons = [];

  if (!fs.existsSync(worktreePath)) return { removable: false, reasons: ["worktree のフォルダが既にありません"] };

  const status = runGit(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) return { removable: false, reasons: [`状態を取得できません: ${status.stderr}`] };
  if (status.stdout.trim()) {
    reasons.push(`未コミットの変更が ${status.stdout.split(/\r?\n/).filter(Boolean).length} 件残っています`);
  }

  if (branch && baseBranch) {
    // 基準ブランチに取り込まれていないコミットがあるか
    const unmerged = runGit(repoPath, ["log", "--oneline", `${baseBranch}..${branch}`]);
    if (unmerged.ok && unmerged.stdout.trim()) {
      const n = unmerged.stdout.split(/\r?\n/).filter(Boolean).length;
      reasons.push(`${baseBranch} に取り込まれていないコミットが ${n} 件あります`);
    }
  } else {
    reasons.push("ブランチ情報が不明なため判定できません");
  }

  return { removable: reasons.length === 0, reasons };
}

/**
 * 安全確認を通ったときだけ worktree を消す。--force は使わない。
 * ブランチは残す（証拠として保持する）。
 */
export function removeWorktreeIfSafe({ repoPath, worktreePath, branch, baseBranch, logger }) {
  const check = canRemoveWorktree({ repoPath, worktreePath, branch, baseBranch });
  if (!check.removable) {
    logger?.info?.("worktree は安全確認を通らなかったので残します", { worktreePath, reasons: check.reasons });
    return { removed: false, reasons: check.reasons };
  }
  const res = runGit(repoPath, ["worktree", "remove", worktreePath]);
  if (!res.ok) {
    return { removed: false, reasons: [`削除に失敗: ${res.stderr || res.stdout}`] };
  }
  logger?.info?.("worktree を削除しました（ブランチは証拠として残します）", { worktreePath, branch });
  return { removed: true, reasons: [] };
}

/** 迷子の worktree 登録を掃除する。フォルダは消さない。 */
export function pruneWorktreeRegistrations(repoPath) {
  return runGit(repoPath, ["worktree", "prune"]).ok;
}
