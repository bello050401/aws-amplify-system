/**
 * Staging への自動ログインだけを単体で実行する(E2Eとは別に確認したいとき用)。
 *
 *   npm run e2e:staging:login
 *
 * 「ログアウト状態の新規ブラウザ → 自動ログイン → Staging画面へ到達」を
 * 確かめるには --fresh を付ける。保存済みの状態を消してから始めるので、
 * 資格情報マネージャーの値だけで入れることを実証できる。
 *
 *   npm run e2e:staging:login -- --fresh
 */
import fs from "node:fs";
import { ensureStagingAuth, hasSavedState, STAGING_STATE_FILE } from "@/e2e/auth/stagingAuth";

async function main() {
  const fresh = process.argv.includes("--fresh");
  const headed = process.argv.includes("--headed");

  if (fresh && hasSavedState()) {
    fs.rmSync(STAGING_STATE_FILE, { force: true });
    console.log("保存済みのログイン状態を削除しました(--fresh)。");
  }
  console.log(`保存済みのログイン状態: ${hasSavedState() ? "あり" : "なし"}`);

  const started = Date.now();
  const result = await ensureStagingAuth({ headless: !headed });
  const total = Date.now() - started;

  console.log("");
  console.log(result.reusedSavedState ? "✓ 保存済みの状態を再利用しました。" : "✓ 自動ログインしました。");
  if (result.username) console.log(`  アカウント: ${result.username}`);
  if (result.loginMs != null) console.log(`  ログイン所要: ${result.loginMs}ms`);
  console.log(`  到達URL   : ${result.finalUrl}`);
  console.log(`  合計       : ${total}ms`);
  console.log(`  状態の保存先: ${STAGING_STATE_FILE}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
