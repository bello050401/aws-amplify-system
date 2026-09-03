/**
 * 診断モード (設定が壊れているときの唯一の起動形態)。
 *
 * 設定を読めなかったときに「それらしい既定値」で本番を動かすと、
 *   * dataRoot が変わって別の DB / worktree を掴む
 *   * allowedTools / disallowedTools / protectedBranches が効かない
 *   * allowPush や isolation の意図が失われる
 * という形で、設定で守っていたはずの安全境界が全部外れる。
 *
 * そこでこのモードでは Claude 実行・キュー処理・inbox 取込を一切起動せず、
 * 「何が壊れているか」を見せるためだけの読み取り専用ダッシュボードを出す。
 * DB も worktree もログも触らない (開かない・作らない)。
 */
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 診断モードは必ずループバックに閉じる。設定が読めない状態で LAN 公開はしない。 */
const DIAGNOSTIC_HOST = "127.0.0.1";
const DIAGNOSTIC_PORT = 4319;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Git に入っている正常版を取り出す。比較の基準として使う。
 * Git が無くても診断モード自体は動かないといけないので、失敗は握りつぶす。
 */
export function readGitVersion(configPath) {
  const dir = path.dirname(configPath);
  const res = spawnSync("git", ["show", `HEAD:./${path.basename(configPath)}`], {
    cwd: dir,
    encoding: "buffer",
    timeout: 15000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(res.stdout);
  } catch {
    return null;
  }
}

/**
 * 壊れた設定 / Git の正常版 / 実際に適用された設定を突き合わせる。
 * 「代替設定で何が変わってしまったか」を人が読める形にする。
 */
export function buildComparison({ corruption, gitText, appliedConfig }) {
  const rows = [];
  let gitParsed = null;
  if (gitText) {
    try {
      gitParsed = JSON.parse(gitText);
    } catch {
      gitParsed = null;
    }
  }

  const salvaged = corruption?.salvage?.salvaged ? corruption.salvage.config : null;

  // 安全境界に直結する項目だけを、確実に見えるところへ並べる。
  const keys = [
    ["git.isolation", (c) => c?.git?.isolation],
    ["git.allowPush", (c) => c?.git?.allowPush],
    ["git.protectedBranches", (c) => c?.git?.protectedBranches],
    ["git.allowInPlaceFallback", (c) => c?.git?.allowInPlaceFallback],
    ["review.provider", (c) => c?.review?.provider],
    ["claude.permissionMode", (c) => c?.claude?.permissionMode],
    ["claude.allowedTools (件数)", (c) => c?.claude?.allowedTools?.length],
    ["claude.disallowedTools (件数)", (c) => c?.claude?.disallowedTools?.length],
    ["dataRoot", (c) => c?.dataRoot],
    ["repoPath", (c) => c?.repoPath],
    ["dashboard.lanAccess", (c) => c?.dashboard?.lanAccess],
  ];

  for (const [label, pick] of keys) {
    rows.push({
      key: label,
      git: format(pick(gitParsed)),
      corrupted: format(pick(salvaged)),
      applied: format(pick(appliedConfig)),
    });
  }
  return rows;
}

function format(value) {
  if (value === undefined) return "(読めません)";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * 診断モードのダッシュボードを起動する。Claude は起動しない。
 *
 * @returns {Promise<{server: http.Server, url: string, close: () => Promise<void>}>}
 */
export async function startDiagnosticDashboard({ configPath, corruption, quarantine, appliedConfig = null, host = DIAGNOSTIC_HOST, port = DIAGNOSTIC_PORT, logLine = () => {} }) {
  const gitText = readGitVersion(configPath);
  const comparison = buildComparison({ corruption, gitText, appliedConfig });

  const state = {
    mode: "diagnostic",
    claudeExecution: "停止中 (診断モードでは実行しません)",
    queueProcessing: "停止中",
    inboxWatch: "停止中",
    configPath,
    corruption: corruption
      ? {
          sha256: corruption.sha256,
          issues: corruption.issues,
          salvage: { salvaged: corruption.salvage?.salvaged ?? false, reason: corruption.salvage?.reason ?? null },
        }
      : null,
    quarantine: quarantine ? { copyPath: quarantine.copyPath, metaPath: quarantine.metaPath, sha256: quarantine.meta.sha256 } : null,
    gitVersionAvailable: Boolean(gitText),
    comparison,
  };

  const server = http.createServer((req, res) => {
    // 診断モードは読み取り専用。書き込み系は一切受け付けない。
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "診断モードでは操作を受け付けません。" }));
      return;
    }
    const route = new URL(req.url, `http://${host}:${port}`).pathname;
    if (route === "/api/diagnostic") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(state, null, 2));
      return;
    }
    if (route === "/" || route === "/index.html") {
      const body = renderPage(state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "診断モードでは他の画面は出ません。" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const url = `http://${host}:${server.address().port}/`;
  logLine(`診断モードのダッシュボード: ${url}`);
  return {
    server,
    url,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function renderPage(state) {
  const issues = (state.corruption?.issues ?? [])
    .map((i) => `<li><code>${escapeHtml(i.kind)}</code> — ${escapeHtml(i.message)}${i.sample ? `<pre>${escapeHtml(i.sample)}</pre>` : ""}</li>`)
    .join("");

  const rows = state.comparison
    .map(
      (r) =>
        `<tr><th>${escapeHtml(r.key)}</th><td>${escapeHtml(r.git)}</td><td>${escapeHtml(r.corrupted)}</td><td>${escapeHtml(r.applied)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>BELLO Orchestrator — 診断モード</title>
<style>
 body{font-family:"Segoe UI","Yu Gothic UI",sans-serif;margin:0;background:#1b1d21;color:#e8e8e8}
 .wrap{max-width:1000px;margin:0 auto;padding:24px}
 .banner{background:#7a2020;border:1px solid #b04040;padding:16px 20px;border-radius:8px}
 .banner h1{margin:0 0 6px;font-size:20px}
 h2{margin-top:32px;font-size:16px;border-bottom:1px solid #3a3d43;padding-bottom:6px}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{border:1px solid #3a3d43;padding:6px 10px;text-align:left;vertical-align:top}
 thead th{background:#2a2d33}
 tbody th{background:#242730;white-space:nowrap}
 code{background:#2a2d33;padding:1px 5px;border-radius:3px}
 pre{background:#111;padding:8px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
 .ok{color:#7fd07f} .stop{color:#ff9c9c}
 li{margin-bottom:10px}
</style></head><body><div class="wrap">
<div class="banner">
  <h1>診断モードで起動しています</h1>
  <p>設定ファイルが壊れているため、<strong>タスクの自動実行を停止</strong>しています。
  この画面は読み取り専用です。</p>
</div>

<h2>実行状態</h2>
<table><tbody>
<tr><th>Claude 実行</th><td class="stop">${escapeHtml(state.claudeExecution)}</td></tr>
<tr><th>キュー処理</th><td class="stop">${escapeHtml(state.queueProcessing)}</td></tr>
<tr><th>inbox 取込</th><td class="stop">${escapeHtml(state.inboxWatch)}</td></tr>
<tr><th>設定ファイル</th><td><code>${escapeHtml(state.configPath)}</code></td></tr>
<tr><th>壊れた版の SHA-256</th><td><code>${escapeHtml(state.corruption?.sha256 ?? "-")}</code></td></tr>
</tbody></table>

<h2>検出した問題</h2>
<ul>${issues || "<li>(なし)</li>"}</ul>

<h2>証拠の隔離先</h2>
${
  state.quarantine
    ? `<p>元ファイルは削除していません。次の場所へコピーを保存しました。</p>
       <pre>${escapeHtml(state.quarantine.copyPath)}\n${escapeHtml(state.quarantine.metaPath)}\nSHA-256: ${escapeHtml(state.quarantine.sha256)}</pre>`
    : "<p>(隔離していません)</p>"
}

<h2>Git の正常版 / 壊れた版 / 実際に適用された設定</h2>
${state.gitVersionAvailable ? "" : "<p>Git の正常版を取り出せませんでした。</p>"}
<table><thead><tr><th>項目</th><th>Git の正常版</th><th>壊れた版から救出</th><th>実際に適用</th></tr></thead>
<tbody>${rows}</tbody></table>

<h2>復旧手順</h2>
<pre>bello.ps1 config-check     # 何が壊れているかをもう一度確認する
bello.ps1 config-repair    # 隔離 → 救出 → 検証 → atomic 置換
bello.ps1 start            # 通常モードで再起動する</pre>
</div></body></html>`;
}

export { DIAGNOSTIC_HOST, DIAGNOSTIC_PORT };
