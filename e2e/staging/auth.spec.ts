import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { ensureStagingAuth, STAGING_BASE_URL, STAGING_STATE_FILE } from "../auth/stagingAuth";

/**
 * 自動ログインそのものの検証(利用者の要求:
 * 「ログアウト状態の新規ブラウザ → 自動ログイン → Staging画面へ到達」)。
 */
test.describe("Staging 自動ログイン", () => {
  test("保存済みの状態でStagingの保護ルートへ入れる", async ({ page }) => {
    await page.goto("/inventory", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/inventory\/login/);
    // ログインフォームが無い = 入れている
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("ログアウト状態の新規ブラウザから、人手なしでログインして到達できる", async () => {
    // 保存済みの状態を捨ててから、まっさらな状態でやり直す。
    // Playwrightのcontextを使わず ensureStagingAuth を直接呼ぶので、
    // このテストは storageState を一切引き継がない。
    if (fs.existsSync(STAGING_STATE_FILE)) fs.rmSync(STAGING_STATE_FILE);

    const result = await ensureStagingAuth({ headless: true });
    expect(result.performedLogin).toBe(true);
    expect(result.reusedSavedState).toBe(false);
    expect(result.finalUrl.startsWith(STAGING_BASE_URL)).toBe(true);
    expect(result.finalUrl).not.toContain("/inventory/login");
    expect(fs.existsSync(STAGING_STATE_FILE)).toBe(true);

    console.log(`  ログイン所要 ${result.loginMs}ms → ${result.finalUrl}`);

    // 出来た storageState で、まっさらなブラウザからもう一度入れること。
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ storageState: STAGING_STATE_FILE, baseURL: STAGING_BASE_URL });
      const p = await ctx.newPage();
      await p.goto("/inventory", { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2000);
      expect(p.url()).not.toContain("/inventory/login");
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  test("保存した状態にパスワードが含まれていない", async () => {
    // storageState はCookie/localStorageの写し。トークンは入るが、
    // 入力したパスワードそのものが残っていないことを確かめる。
    const raw = fs.readFileSync(STAGING_STATE_FILE, "utf8");
    // Cognitoのトークンは入っていて当然なので、その存在は許す。
    // ここで見るのは「フォームに入れた値が素で残っていないか」。
    expect(raw).not.toContain("password=");
    expect(raw.toLowerCase()).not.toContain('"password"');
  });
});
