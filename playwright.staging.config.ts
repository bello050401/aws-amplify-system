import { defineConfig } from "@playwright/test";
import { STAGING_BASE_URL, STAGING_STATE_FILE } from "./e2e/auth/stagingAuth";

/**
 * Staging(実機)向けの Playwright 設定。
 *
 * ── 既存の playwright.config.ts と別にしてある理由 ─────────────
 *
 * あちらは「ローカルの `next dev` を起動し、fixture と認証bypassで
 * 保護ルートを描画してモバイル幅の横スクロールを測る」ためのもので、
 *   ・webServer で next dev を立てる
 *   ・executablePath が /opt/pw-browsers/chromium (Linux コンテナ用の絶対パス)
 * という前提が入っている。Windows の実機から Staging を叩く用途とは
 * 前提がまったく違うので、同じファイルへ条件分岐を足さずに分ける。
 *
 * ── 認証 ────────────────────────────────────────────────────────
 *
 * globalSetup が Windows 資格情報マネージャーの値で自動ログインし、
 * storageState を作る。各テストはその状態から始まるので、テスト側は
 * ログインの存在を意識しない。
 */
export default defineConfig({
  testDir: "./e2e/staging",
  // Staging は実ネットワーク越し。ローカルの dev server より余裕を持たせる。
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // 実データを触る画面(画像加工の予約等)を含むので、同時に走らせない。
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/auth/globalSetup.ts",
  use: {
    baseURL: STAGING_BASE_URL,
    storageState: STAGING_STATE_FILE,
    // 失敗時だけ痕跡を残す。成功時のスクリーンショットは各テストが
    // 明示的に撮る(パスワード欄が写る画面は撮らない)。
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
});
