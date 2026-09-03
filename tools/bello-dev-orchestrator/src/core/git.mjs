/**
 * Git 安全策 (指示書 §12-3)。
 *
 * ここには reset --hard / checkout -- / stash / clean を一切実装しない。
 * ユーザーの未コミット変更を退避・破棄する手段を持たないことが安全策そのもの。
 */
import { spawnSync } from "node:child_process";
import { redactText } from "../log/redact.mjs";
import { assertGitCommandAllowed, ForbiddenGitCommandError } from "./gitGuard.mjs";

/**
 * git を実行する唯一の入口。ここを通らない git 実行を作らないこと。
 *
 * 危険な使い方 (git add -A / commit -a / reset --hard / stash / clean / push …) は
 * gitGuard が実行前に落とす。これは「書かないよう気をつける」より強い保証で、
 * 他人の未コミット変更を巻き込む事故を構造的に防ぐ。
 */
export function runGit(repoPath, args, { timeout = 60000 } = {}) {
  try {
    assertGitCommandAllowed(args);
  } catch (err) {
    if (err instanceof ForbiddenGitCommandError) {
      return { ok: false, status: null, stdout: "", stderr: err.message, forbidden: true };
    }
    throw err;
  }
  const res = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", timeout, windowsHide: true });
  const raw = String(res.stdout ?? "");
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: raw.trim(),
    // porcelain の行頭は " M file" のように空白で始まる。trim すると 1 文字ずれるので、
    // 行単位で読む用途には必ずこちらを使うこと。
    stdoutRaw: raw,
    stderr: redactText(String(res.stderr ?? "").trim()),
  };
}

const git = runGit;

/**
 * git status --porcelain の 1 行からファイル名を取り出す。
 *
 * 形式は "XY path" または "XY old -> new"。X と Y は 1 文字ずつで、
 * 変更のみ (未ステージ) の場合は X が空白になる。trim 済みの文字列を
 * 渡してはいけない。
 */
export function porcelainPath(line) {
  if (!line || line.length < 4) return null;
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  const unquoted = file.startsWith('"') && file.endsWith('"') ? file.slice(1, -1) : file;
  return unquoted.trim() || null;
}

/** 作業ツリーで変更されているファイル名の一覧 (porcelain を正しく解析する)。 */
export function porcelainFiles(repoPath) {
  const res = git(repoPath, ["status", "--porcelain"]);
  if (!res.ok) return { ok: false, files: [], lines: [], stderr: res.stderr };
  const lines = (res.stdoutRaw ?? "").split(/\r?\n/).filter((l) => l.length > 0);
  return { ok: true, lines, files: lines.map(porcelainPath).filter(Boolean), stderr: "" };
}

export function isGitRepo(repoPath) {
  return git(repoPath, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

export function currentBranch(repoPath) {
  const r = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.stdout : null;
}

export function headCommit(repoPath) {
  const r = git(repoPath, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout : null;
}

/** 作業開始時点の dirty 状態を記録する (§12-3)。 */
export function snapshotWorkingTree(repoPath) {
  const status = porcelainFiles(repoPath);
  const lines = status.lines;
  return {
    branch: currentBranch(repoPath),
    headCommit: headCommit(repoPath),
    dirty: lines.length > 0,
    entries: lines,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * before の時点で既に変更されていたファイルを列挙する。
 * 自動コミットからこれらを除外し、ユーザーの作業を巻き込まないため。
 */
export function preexistingPaths(snapshot) {
  const paths = new Set();
  for (const line of snapshot?.entries ?? []) {
    const file = porcelainPath(line);
    if (file) paths.add(file);
  }
  return paths;
}

export function diffStat(repoPath, fromCommit) {
  if (fromCommit) {
    const r = git(repoPath, ["diff", "--stat", `${fromCommit}..HEAD`]);
    const w = git(repoPath, ["diff", "--stat"]);
    return [r.ok ? r.stdout : "", w.ok ? w.stdout : ""].filter(Boolean).join("\n--- 未コミット分 ---\n");
  }
  const r = git(repoPath, ["diff", "--stat"]);
  return r.ok ? r.stdout : "";
}

export function changedFilesSince(repoPath, fromCommit) {
  const out = new Set();
  if (fromCommit) {
    const r = git(repoPath, ["diff", "--name-only", `${fromCommit}..HEAD`]);
    if (r.ok) r.stdout.split(/\r?\n/).filter(Boolean).forEach((f) => out.add(f));
  }
  for (const file of porcelainFiles(repoPath).files) out.add(file);
  return [...out];
}

/**
 * タスクが触ったファイルを、別の誰かも触っていないかを調べる。
 *
 * 見るのは 2 つ。
 *   1. 基準コミット以降に本体リポジトリへ入った新しいコミット
 *   2. 本体リポジトリの、いまの未コミット変更
 * どちらかに同じパスがあれば「別セッションが同じファイルを触っている」。
 *
 * 自動でマージは一切しない。人に判断してもらう。
 */
export function detectCrossSessionConflicts({ repoPath, baseCommit, taskFiles }) {
  const mine = new Set((taskFiles ?? []).filter(Boolean));
  if (mine.size === 0) return { conflicts: [], newCommits: [], checked: true };

  const conflicts = new Map();

  // 1. 基準コミット以降に入ったコミットの変更ファイル
  let newCommits = [];
  if (baseCommit) {
    const log = git(repoPath, ["log", "--oneline", `${baseCommit}..HEAD`]);
    if (log.ok && log.stdout.trim()) {
      newCommits = log.stdout.split(/\r?\n/).filter(Boolean);
      const names = git(repoPath, ["diff", "--name-only", `${baseCommit}..HEAD`]);
      if (names.ok) {
        for (const f of names.stdout.split(/\r?\n/).filter(Boolean)) {
          if (mine.has(f)) conflicts.set(f, "基準コミット以降に本体へコミットされた");
        }
      }
    }
  }

  // 2. 本体リポジトリの未コミット変更
  for (const file of porcelainFiles(repoPath).files) {
    if (mine.has(file)) {
      conflicts.set(
        file,
        conflicts.has(file) ? conflicts.get(file) + " / 本体に未コミット変更あり" : "本体に未コミット変更あり",
      );
    }
  }

  return {
    conflicts: [...conflicts].map(([file, why]) => ({ file, why })),
    newCommits,
    checked: true,
  };
}

/**
 * worktree の中で、そのタスクが作った変更ファイルを列挙する。
 *
 * worktree は基準コミットのきれいな複製から始まっているので、ここで出てくる
 * ものはすべてタスクが作ったもの。開始前の未コミット変更は複製されていない。
 */
export function taskChangedFilesInWorktree(worktreePath, baseCommit) {
  const files = new Set();
  for (const file of porcelainFiles(worktreePath).files) files.add(file);
  if (baseCommit) {
    const committed = git(worktreePath, ["diff", "--name-only", `${baseCommit}..HEAD`]);
    if (committed.ok) for (const f of committed.stdout.split(/\r?\n/).filter(Boolean)) files.add(f);
  }
  return [...files];
}

export function isProtectedBranch(branch, protectedBranches) {
  if (!branch) return false;
  return (protectedBranches ?? []).includes(branch);
}

/** 秘密・DB・ログ・投入文書など、コミットしてはいけないパターン。 */
export function excludeReason(file) {
  if (/(^|\/)\.env($|\.)|(^|\/)\.env\.local$/.test(file) || /\.(pem|key|pfx|p12)$/i.test(file)) {
    return "秘密情報の可能性";
  }
  if (/(^|\/)(orchestrator\.db|.*\.sqlite3?|.*\.log)$/i.test(file)) return "DB / ログ";
  if (/\.docx?$/i.test(file) && /inbox|processed|uploads/i.test(file)) return "投入 Word 文書";
  return null;
}

/**
 * タスク単位のコミット。
 *
 * - 保護ブランチでは絶対にコミットしない。
 * - **allowedFiles を渡した場合、そこに無いファイルは何があっても stage しない。**
 *   worktree 方式では「そのタスクが作ったと証明できるファイル」がここに入る。
 * - allowedFiles を渡さない場合（同一ツリー方式）は、作業開始前から dirty だった
 *   ファイルを除外する。どちらの経路でも、他人の変更には触れない。
 * - 秘密・巨大ログ・DB・inbox 文書は常に除外する (§12-3)。
 * - stage は必ず `git add -- <path> ...` の明示指定。gitGuard が -A / . を落とす。
 */
export function commitTaskChanges({
  repoPath,
  branch,
  message,
  snapshot,
  protectedBranches,
  allowedFiles = null,
  maxFileBytes = 5 * 1024 * 1024,
}) {
  if (isProtectedBranch(branch, protectedBranches)) {
    return { committed: false, reason: `保護ブランチ ${branch} では自動コミットしません。` };
  }

  const allowSet = allowedFiles ? new Set(allowedFiles) : null;
  const preexisting = preexistingPaths(snapshot);
  const status = porcelainFiles(repoPath);
  if (!status.ok) return { committed: false, reason: `git status に失敗: ${status.stderr}` };

  const candidates = [];
  const skipped = [];
  for (const file of status.files) {
    // 許可リストがあるときは、それが最優先の門番。
    if (allowSet && !allowSet.has(file)) {
      skipped.push({ file, why: "このタスクが作ったと証明できないファイル" });
      continue;
    }
    if (preexisting.has(file)) {
      skipped.push({ file, why: "作業開始前から変更されていたユーザーの変更" });
      continue;
    }
    const excluded = excludeReason(file);
    if (excluded) {
      skipped.push({ file, why: excluded });
      continue;
    }
    candidates.push(file);
  }

  if (candidates.length === 0) {
    return { committed: false, reason: "コミット対象の変更がありません。", skipped };
  }

  // 明示指定の add。gitGuard がパス無し / -A / . を拒否するので、
  // ここで無差別ステージになることはない。
  const added = git(repoPath, ["add", "--", ...candidates]);
  if (!added.ok) return { committed: false, reason: `git add に失敗: ${added.stderr}`, skipped };

  // stage した内容が候補と一致するかを念のため確認する。
  // フックや別プロセスが割り込んで余計なものが index に入っていないかの検算。
  const staged = git(repoPath, ["diff", "--cached", "--name-only"]);
  if (staged.ok) {
    const unexpected = staged.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((f) => !candidates.includes(f));
    if (unexpected.length > 0) {
      git(repoPath, ["reset", "--", ...unexpected]);
      const recheck = git(repoPath, ["diff", "--cached", "--name-only"]);
      const still = recheck.ok
        ? recheck.stdout.split(/\r?\n/).filter(Boolean).filter((f) => !candidates.includes(f))
        : unexpected;
      if (still.length > 0) {
        git(repoPath, ["reset", "--", ...candidates]);
        return {
          committed: false,
          reason: `意図しないファイルが index に入っていたため中止しました: ${still.join(", ")}`,
          skipped,
        };
      }
    }
  }

  const before = headCommit(repoPath);
  const res = git(repoPath, ["commit", "-m", message]);
  const after = headCommit(repoPath);
  if (!res.ok || before === after) {
    // 失敗したらインデックスを元に戻す (作業ツリーは触らない)
    git(repoPath, ["reset", "--", ...candidates]);
    return { committed: false, reason: `git commit に失敗: ${res.stderr || res.stdout}`, skipped };
  }
  return { committed: true, commit: after, files: candidates, skipped };
}
