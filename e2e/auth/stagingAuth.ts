import { chromium, type Browser, type Page } from "@playwright/test";
import { readStagingCredential, redactSecrets } from "./credentialStore";
import {
  STORAGE_STATE_FILE,
  inspectStorageState,
  removeStorageState,
  writeStorageStateAtomic,
} from "./storageStateFile";

/**
 * Staging への自動ログインと、その状態(storageState)の再利用。
 *
 * ── 方針 ────────────────────────────────────────────────────────
 *
 * 1. 保存済みの storageState を**まず検査**し、使える形なら保護ルートを
 *    開いてみる。通れば何もしない —— 毎回ログインし直すとCognitoへ無駄な
 *    負荷をかけるし、失敗の切り分けも難しくなる。
 * 2. 通らなければ(初回・期限切れ・サインアウト済み・壊れている)、
 *    資格情報マネージャーの値でフォームからログインし、保存し直す。
 *
 * ── 認可を弱めない ──────────────────────────────────────────────
 *
 * ここは既存のログイン画面を人と同じ手順で操作するだけ。Cognitoの設定・
 * グループ・MFA・アプリ側の認可判定には一切触れない。ローカル開発用の
 * E2E認証バイパス(INVENTORY_E2E_AUTH_TOKEN)も使わない —— あれは
 * NODE_ENV!=="production" でしか効かず、Stagingでは構造的に通らない。
 *
 * ── trace / screenshot に秘密が入らない理由 ────────────────────
 *
 * ログインはここで**独自に起動したブラウザ**の中だけで行う。Playwright の
 * テストフィクスチャが作る context ではないので、`trace` にも `video` にも
 * 記録されない。trace はアクションの引数(fill の値)を保持するため、
 * ログインをテスト本体で行うと trace ファイルにパスワードが残りうる。
 * そうならない構造にしてある。
 */

const STAGING_ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

export const STAGING_BASE_URL = STAGING_ORIGIN;
export const STAGING_STATE_FILE = STORAGE_STATE_FILE;

const PROTECTED_PATH = "/inventory";
const LOGIN_PATH = "/inventory/login";

export { inspectStorageState, removeStorageState } from "./storageStateFile";

export function hasSavedState(): boolean {
  return inspectStorageState().kind === "ok";
}

/**
 * いま開いているページが「ログイン済みの保護ルート」かどうか。
 *
 * ── なぜ3つとも見るのか ────────────────────────────────────────
 *
 * 「URLがloginでない かつ パスワード欄が無い」だけで判定していた版には
 * 抜けがあった: ナビゲーションが失敗して about:blank のままだと、
 * URLにloginを含まず、パスワード欄も無いので **ログイン済みと誤判定**する。
 * 失敗を成功として扱うのが一番たちが悪い。
 *
 * そこで「入れている」ことを示す**積極的な証拠**も要求する。保護ルート
 * (app/inventory/(protected)/layout.tsx)は必ずナビゲーションレールを
 * 描画し、ログイン画面には無い。
 */
async function isSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.startsWith(STAGING_ORIGIN)) return false; // about:blank 等
  if (url.includes(LOGIN_PATH)) return false;
  if ((await page.locator('input[type="password"]').count()) > 0) return false;
  // 保護ルートのレイアウトだけが持つ要素。
  return (await page.locator("nav").count()) > 0;
}

export interface EnsureAuthResult {
  /** 保存済みの状態をそのまま使えたか。 */
  reusedSavedState: boolean;
  /** 実際にログインフォームを操作したか。 */
  performedLogin: boolean;
  /** どのアカウントで入っているか(メールアドレス。パスワードは含まない)。 */
  username: string | null;
  finalUrl: string;
  /** ログイン所要ミリ秒(performedLogin のときだけ)。 */
  loginMs: number | null;
  /** 保存状態を再利用しなかった理由(監査用。値は含まない)。 */
  savedStateStatus: string;
}

export async function ensureStagingAuth(options: { headless?: boolean } = {}): Promise<EnsureAuthResult> {
  const headless = options.headless ?? true;
  const state = inspectStorageState();
  let savedStateStatus: string = state.kind;

  const browser: Browser = await chromium.launch({ headless });
  try {
    // ── 1. 保存済みの状態で入れるか ─────────────────────────────
    if (state.kind === "ok") {
      const reuse = await tryReuseSavedState(browser);
      if (reuse) return { ...reuse, savedStateStatus };
      savedStateStatus = "expired";
    } else if (state.kind !== "missing") {
      // 壊れている/読めない。ここで止めず、捨てて作り直す。
      console.warn(`[staging-auth] 保存済みのログイン状態を使えません(${state.kind}): ${state.detail}`);
      removeStorageState();
    }

    // ── 2. 資格情報マネージャーの値でログインする ───────────────
    return { ...(await performLogin(browser)), savedStateStatus };
  } finally {
    await browser.close();
  }
}

async function tryReuseSavedState(browser: Browser): Promise<Omit<EnsureAuthResult, "savedStateStatus"> | null> {
  // newContext は壊れた storageState で例外を投げる。inspectStorageState
  // で先に弾いているが、競合で壊れる可能性は残るので try の内側に置く。
  let context;
  try {
    context = await browser.newContext({ storageState: STAGING_STATE_FILE, baseURL: STAGING_ORIGIN });
  } catch (err) {
    console.warn(
      `[staging-auth] 保存済みの状態を読み込めませんでした: ${err instanceof Error ? err.name : "unknown"}`,
    );
    removeStorageState();
    return null;
  }

  try {
    const page = await context.newPage();
    await page.goto(`${STAGING_ORIGIN}${PROTECTED_PATH}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // クライアント側のセッション確認とリダイレクトが落ち着くのを待つ。
    await page.waitForTimeout(2_500);
    if (!(await isSignedIn(page))) return null;

    // 使えた。トークンが更新されている場合に備えて保存し直す。
    writeStorageStateAtomic(JSON.stringify(await context.storageState(), null, 2));
    return {
      reusedSavedState: true,
      performedLogin: false,
      username: null,
      finalUrl: page.url(),
      loginMs: null,
    };
  } catch {
    // 到達できなかった場合もログインし直しへ倒す(黙って成功にしない)。
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

async function performLogin(browser: Browser): Promise<Omit<EnsureAuthResult, "savedStateStatus">> {
  const credential = await readStagingCredential();
  const context = await browser.newContext({ baseURL: STAGING_ORIGIN });

  try {
    const page = await context.newPage();
    const startedAt = Date.now();

    await page.goto(`${STAGING_ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // 既存セッションの確認が終わるまでフォームは出ない。
    await page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 });

    await page.locator('input[type="email"]').fill(credential.username);
    await page.locator('input[type="password"]').fill(credential.password);
    await page.locator('button[type="submit"]').click();

    // 成功なら保護ルートへ、失敗ならフォームにエラーが出る。
    // どちらが先に起きても拾えるように両方待つ。
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith(LOGIN_PATH), { timeout: 60_000 }),
      page.locator("form p.text-red-600").waitFor({ state: "visible", timeout: 60_000 }),
    ]).catch(() => {
      /* どちらも起きなければ下の判定で落とす */
    });
    await page.waitForTimeout(1_500);

    if (!(await isSignedIn(page))) {
      throw new Error(redactSecrets(await describeLoginFailure(page), [credential.password]));
    }

    const loginMs = Date.now() - startedAt;
    writeStorageStateAtomic(JSON.stringify(await context.storageState(), null, 2));
    return {
      reusedSavedState: false,
      performedLogin: true,
      username: credential.username,
      finalUrl: page.url(),
      loginMs,
    };
  } catch (err) {
    // 念のため、投げる前にもう一度伏せる。
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), [credential.password]));
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * ログインできなかった理由を、人が次に何をすればよいか分かる形にする。
 * 画面に出ている文言だけを読む —— 入力値は読まない。
 */
async function describeLoginFailure(page: Page): Promise<string> {
  const needsNewPassword = (await page.getByText("新しいパスワード").count()) > 0;
  if (needsNewPassword) {
    return (
      "Staging へのログインに失敗しました: Cognito が新しいパスワードの設定を求めています" +
      "(NEW_PASSWORD_REQUIRED)。一度ブラウザで手動ログインしてパスワードを確定させてから、" +
      "資格情報を登録し直してください。"
    );
  }
  const message = await page
    .locator("form p.text-red-600")
    .first()
    .textContent()
    .catch(() => null);
  if (message?.trim()) return `Staging へのログインに失敗しました: ${message.trim()}`;
  return `Staging へのログインに失敗しました: ログイン画面から遷移しませんでした(現在のURL: ${page.url()})。`;
}
