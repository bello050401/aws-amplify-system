import { ensureStagingAuth } from "./stagingAuth";

/**
 * Staging E2E の入口。テストが1つでも走る前に、認証状態を用意する。
 *
 * 出力するのは「再利用したのか、ログインし直したのか」「どのアカウントか」
 * 「どこへ到達したか」だけ。パスワードもCookieもトークンも出さない。
 */
export default async function globalSetup(): Promise<void> {
  const result = await ensureStagingAuth({ headless: true });
  if (result.reusedSavedState) {
    console.log(`[staging-auth] 保存済みのログイン状態を再利用しました → ${result.finalUrl}`);
  } else {
    console.log(
      `[staging-auth] 自動ログインしました (${result.username}) ` +
        `${result.loginMs}ms → ${result.finalUrl}`,
    );
  }
}
