import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser, type Page } from "@playwright/test";
import { readStagingCredential, redactSecrets } from "./credentialStore";

/**
 * Staging への自動ログインと、その状態(storageState)の再利用。
 *
 * ── 方針 ────────────────────────────────────────────────────────
 *
 * 1. 保存済みの storageState があれば、まずそれで保護ルートを開いてみる。
 *    通れば何もしない —— 毎回ログインし直すとCognitoに無駄な負荷をかけるし、
 *    失敗の切り分けも難しくなる。
 * 2. 通らなければ(初回・期限切れ・サインアウト済み)、資格情報マネージャーの
 *    値でフォームからログインし、storageState を保存し直す。
 *
 * ── storageState を「認証情報」として扱う ──────────────────────
 *
 * このファイルには生きた Cognito のトークンが入っている。パスワードと
 * 同じ扱いが要る:
 *   ・リポジトリの外(%LOCALAPPDATA%\BELLO\playwright)へ置く
 *   ・作成時にファイル権限を現在のユーザーだけへ絞る
 *   ・Remove-BelloStagingCredential.ps1 がパスワードと一緒に消す
 *
 * ── 認可を弱めない ──────────────────────────────────────────────
 *
 * ここは既存のログイン画面を人と同じ手順で操作するだけで、Cognitoの設定、
 * グループ、MFA、アプリ側の認可判定には一切触れない。
 * ローカル開発用の E2E バイパス(INVENTORY_E2E_AUTH_TOKEN)も使わない
 * —— あれは NODE_ENV!=="production" でしか効かず、Staging では
 * 構造的に通らないうえ、通す必要も無い。
 */

const STAGING_ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

/** 認証状態の保存先。リポジトリの外。 */
const STATE_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "BELLO", "playwright");
const STATE_FILE = path.join(STATE_DIR, "staging-storage-state.json");

export const STAGING_BASE_URL = STAGING_ORIGIN;
export const STAGING_STATE_FILE = STATE_FILE;

/** ログイン後に到達していれば「入れている」と判断できる保護ルート。 */
const PROTECTED_PATH = "/inventory";
const LOGIN_PATH = "/inventory/login";

export function hasSavedState(): boolean {
  return fs.existsSync(STATE_FILE);
}

function saveState(json: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 0o600 相当。Windowsでは実効的な制限にならないことがあるが、
  // 付けない理由にはならない(WSL/将来のCIでは効く)。
  fs.writeFileSync(STATE_FILE, json, { encoding: "utf8", mode: 0o600 });
}

/**
 * いま開いているページがログイン画面へ飛ばされていないか。
 *
 * 未ログインだと `/inventory` は `/inventory/login` へリダイレクトされる
 * (app/inventory/(protected)/layout.tsx)。URLだけで判定すると、
 * ログイン画面がクライアント側で `/inventory` へ戻す一瞬を拾って
 * 誤判定しうるので、**画面に出ている要素**でも確かめる。
 */
async function isSignedIn(page: Page): Promise<boolean> {
  if (page.url().includes(LOGIN_PATH)) return false;
  // 保護ルートのヘッダには必ずナビゲーションがある。ログイン画面には無い。
  const loginForm = page.locator('input[type="password"]');
  return (await loginForm.count()) === 0;
}

export interface EnsureAuthResult {
  /** 保存済みの状態をそのまま使えたか。 */
  reusedSavedState: boolean;
  /** 実際にログインフォームを操作したか。 */
  performedLogin: boolean;
  /** どのアカウントで入っているか(メールアドレス。パスワードは含まない)。 */
  username: string | null;
  /** 到達したURL。 */
  finalUrl: string;
  /** ログイン所要ミリ秒(performedLogin のときだけ)。 */
  loginMs: number | null;
}

/**
 * 保存済みの状態を試し、駄目なら自動ログインして storageState を作る。
 * 呼び出しは Playwright の globalSetup から1回だけ。
 */
export async function ensureStagingAuth(options: { headless?: boolean } = {}): Promise<EnsureAuthResult> {
  const headless = options.headless ?? true;
  const browser: Browser = await chromium.launch({ headless });

  try {
    // ── 1. 保存済みの状態で入れるか ─────────────────────────────
    if (hasSavedState()) {
      const context = await browser.newContext({ storageState: STATE_FILE, baseURL: STAGING_ORIGIN });
      const page = await context.newPage();
      try {
        await page.goto(`${STAGING_ORIGIN}${PROTECTED_PATH}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        // クライアント側のセッション確認とリダイレクトが落ち着くのを待つ。
        await page.waitForTimeout(2_500);
        if (await isSignedIn(page)) {
          // 使えた。トークンが更新されている場合に備えて保存し直す。
          saveState(JSON.stringify(await context.storageState(), null, 2));
          const url = page.url();
          await context.close();
          return { reusedSavedState: true, performedLogin: false, username: null, finalUrl: url, loginMs: null };
        }
      } catch {
        // 到達できなかった場合もログインし直しへ倒す(黙って成功にしない)。
      }
      await context.close();
    }

    // ── 2. 資格情報マネージャーの値でログインする ───────────────
    const credential = await readStagingCredential();
    const context = await browser.newContext({ baseURL: STAGING_ORIGIN });
    const page = await context.newPage();

    try {
      const startedAt = Date.now();
      await page.goto(`${STAGING_ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // 既存セッションの確認が終わるまでフォームは出ない。
      await page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 });

      await page.locator('input[type="email"]').fill(credential.username);
      await page.locator('input[type="password"]').fill(credential.password);
      await page.locator('button[type="submit"]').click();

      // 成功なら /inventory へ、失敗ならフォームにエラーが出る。
      // どちらが先に起きても拾えるように両方待つ。
      await Promise.race([
        page.waitForURL((url) => !url.pathname.startsWith(LOGIN_PATH), { timeout: 60_000 }),
        page.locator("form p.text-red-600").waitFor({ state: "visible", timeout: 60_000 }),
      ]).catch(() => {
        /* どちらも起きなければ下の判定で落とす */
      });

      await page.waitForTimeout(1_500);

      if (!(await isSignedIn(page))) {
        // 画面に出ているエラー文言を拾う。パスワードは出さない。
        const message = await page
          .locator("form p.text-red-600")
          .first()
          .textContent()
          .catch(() => null);
        // NEW_PASSWORD_REQUIRED はフォームの見た目が変わるので区別する。
        const needsNewPassword = (await page.getByText("新しいパスワード").count()) > 0;
        const detail = needsNewPassword
          ? "Cognito が新しいパスワードの設定を求めています(NEW_PASSWORD_REQUIRED)。一度ブラウザで手動ログインしてパスワードを確定させてから、登録し直してください。"
          : (message ?? "ログイン画面から遷移しませんでした。");
        throw new Error(redactSecrets(`Staging へのログインに失敗しました: ${detail}`, [credential.password]));
      }

      const loginMs = Date.now() - startedAt;
      saveState(JSON.stringify(await context.storageState(), null, 2));
      const url = page.url();
      await context.close();
      return { reusedSavedState: false, performedLogin: true, username: credential.username, finalUrl: url, loginMs };
    } catch (err) {
      await context.close().catch(() => {});
      // 念のため、投げる前にもう一度伏せる。
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), [credential.password]));
    }
  } finally {
    await browser.close();
  }
}
