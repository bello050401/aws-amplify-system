/**
 * Git 安全策 (指示書 §12-3)。
 *
 * ここには reset --hard / checkout -- / stash / clean を一切実装しない。
 * ユーザーの未コミット変更を退避・破棄する手段を持たないことが安全策そのもの。
 */
import { spawnSync } from "node:child_process";
import { redactText } from "../log/redact.mjs";

function git(repoPath, args, { timeout = 60000 } = {}) {
  const res = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", timeout, windowsHide: true });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout ?? "").trim(),
    stderr: redactText(String(res.stderr ?? "").trim()),
  };
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
  const status = git(repoPath, ["status", "--porcelain"]);
  const lines = status.ok ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
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
    // porcelain v1: "XY path" / "XY old -> new"
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    paths.add(arrow >= 0 ? rest.slice(arrow + 4) : rest);
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
  const w = git(repoPath, ["status", "--porcelain"]);
  if (w.ok) {
    for (const line of w.stdout.split(/\r?\n/).filter(Boolean)) {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      out.add(arrow >= 0 ? rest.slice(arrow + 4) : rest);
    }
  }
  return [...out];
}

export function isProtectedBranch(branch, protectedBranches) {
  if (!branch) return false;
  return (protectedBranches ?? []).includes(branch);
}

/**
 * タスク単位のコミット。
 * - 保護ブランチでは絶対にコミットしない。
 * - 作業開始前から dirty だったファイルは add しない (ユーザーの変更を巻き込まない)。
 * - 秘密・巨大ログ・DB・inbox 文書が混ざらないよう除外パターンを適用する (§12-3)。
 */
export function commitTaskChanges({ repoPath, branch, message, snapshot, protectedBranches, maxFileBytes = 5 * 1024 * 1024 }) {
  if (isProtectedBranch(branch, protectedBranches)) {
    return { committed: false, reason: `保護ブランチ ${branch} では自動コミットしません。` };
  }

  const preexisting = preexistingPaths(snapshot);
  const status = git(repoPath, ["status", "--porcelain"]);
  if (!status.ok) return { committed: false, reason: `git status に失敗: ${status.stderr}` };

  const candidates = [];
  const skipped = [];
  for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    if (preexisting.has(file)) {
      skipped.push({ file, why: "作業開始前から変更されていたユーザーの変更" });
      continue;
    }
    if (/(^|\/)\.env($|\.)|(^|\/)\.env\.local$/.test(file) || /\.(pem|key|pfx|p12)$/i.test(file)) {
      skipped.push({ file, why: "秘密情報の可能性" });
      continue;
    }
    if (/(^|\/)(orchestrator\.db|.*\.sqlite3?|.*\.log)$/i.test(file)) {
      skipped.push({ file, why: "DB / ログ" });
      continue;
    }
    if (/\.docx?$/i.test(file) && /inbox|processed|uploads/i.test(file)) {
      skipped.push({ file, why: "投入 Word 文書" });
      continue;
    }
    candidates.push(file);
  }

  if (candidates.length === 0) {
    return { committed: false, reason: "コミット対象の変更がありません。", skipped };
  }

  const added = git(repoPath, ["add", "--", ...candidates]);
  if (!added.ok) return { committed: false, reason: `git add に失敗: ${added.stderr}`, skipped };

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
