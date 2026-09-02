import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Playwright の storageState ファイルの読み書き。
 *
 * ── これは「認証情報ファイル」である ────────────────────────────
 *
 * 中身は生きた Cognito のトークンで、これがあれば誰でもログイン済みの
 * ブラウザを作れる。パスワードと同じ扱いが要る:
 *
 *   ・リポジトリの外へ置く(.gitignore だけに頼らない)
 *   ・作成時に権限を現在のユーザーへ絞る
 *   ・書き込みは atomic に行う(壊れた状態を残さない)
 *   ・パスワードと一緒に消せる
 *
 * ── 壊れたファイルで全体を止めない ──────────────────────────────
 *
 * 中断・ディスク満杯・別プロセスとの競合で、空ファイルや途中まで書かれた
 * JSON が残りうる。それを Playwright の newContext へ渡すと例外になり、
 * 「保存状態が壊れている」という**回復可能な状況**が「E2Eが1件も動かない」
 * という止まり方になる。読む前に検査し、駄目なら捨てて作り直す。
 */

const STATE_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "BELLO",
  "playwright",
);

export const STORAGE_STATE_FILE = path.join(STATE_DIR, "staging-storage-state.json");

export type StorageStateStatus =
  | { kind: "missing" }
  | { kind: "unreadable"; detail: string }
  | { kind: "invalid"; detail: string }
  | { kind: "ok"; cookieCount: number; originCount: number };

/**
 * ファイルが Playwright へ渡せる形かを検査する。
 *
 * **中身の値は一切返さない。** 件数だけを返す —— 呼び出し側がうっかり
 * ログへ出しても、Cookie やトークンが漏れないようにするため。
 */
export function inspectStorageState(file: string = STORAGE_STATE_FILE): StorageStateStatus {
  if (!fs.existsSync(file)) return { kind: "missing" };

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { kind: "unreadable", detail: err instanceof Error ? err.name : "read failed" };
  }

  if (raw.trim() === "") return { kind: "invalid", detail: "ファイルが空です。" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", detail: "JSONとして読めません(書き込み途中で中断した可能性)。" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", detail: "オブジェクトではありません。" };
  }

  const state = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    return { kind: "invalid", detail: "cookies / origins の配列がありません。" };
  }

  // Cookie も localStorage も空なら、ログイン済みの状態ではない
  // (サインアウト後に保存された、等)。使えば必ずログイン画面へ飛ぶので、
  // 先に「使えない」と判定して再ログインへ回す。
  const originEntries = (state.origins as { localStorage?: unknown[] }[]).reduce(
    (sum, o) => sum + (Array.isArray(o?.localStorage) ? o.localStorage.length : 0),
    0,
  );
  if (state.cookies.length === 0 && originEntries === 0) {
    return { kind: "invalid", detail: "CookieもlocalStorageも空です(サインアウト後の状態)。" };
  }

  return { kind: "ok", cookieCount: state.cookies.length, originCount: state.origins.length };
}

export function isStorageStateUsable(file: string = STORAGE_STATE_FILE): boolean {
  return inspectStorageState(file).kind === "ok";
}

/**
 * atomic に書く。
 *
 * 同じディレクトリへ一時ファイルを書いてから rename する。rename は同一
 * ボリューム内では不可分なので、「途中まで書かれた storageState」が
 * 残らない。直接 writeFileSync すると、書き込み中に落ちたときに壊れた
 * ファイルがそのまま次回使われる。
 */
export function writeStorageStateAtomic(json: string, file: string = STORAGE_STATE_FILE): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    // 0o600: 所有者のみ。Windows では実効的な制限にならないことがあるが、
    // 付けない理由にはならない(WSL・将来のCIでは効く)。
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    // rename が成功していれば tmp はもう無い。失敗していたら消す ——
    // 認証情報を含む一時ファイルを置き去りにしない。
    if (fs.existsSync(tmp)) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 消せなくても本処理は続ける。次回の書き込みで上書きされる。 */
      }
    }
  }
}

/** 保存状態を消す。ログアウト相当。 */
export function removeStorageState(file: string = STORAGE_STATE_FILE): void {
  fs.rmSync(file, { force: true });
  // 書き込み途中で残った一時ファイルも一緒に消す。
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`.${path.basename(file)}.`) && name.endsWith(".tmp")) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

/** 保存先がリポジトリの外にあることを、実際のパスで確かめる。 */
export function isOutsideRepository(repoRoot: string, file: string = STORAGE_STATE_FILE): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(file));
  // 相対パスが ".." で始まる、または絶対パスのままなら外側。
  return rel.startsWith("..") || path.isAbsolute(rel);
}
