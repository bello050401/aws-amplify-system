import { defineConfig } from "@playwright/test";

/**
 * 第五ラウンド§7/P1-A: Inventoryの実際の保護されたルート
 * (app/inventory/(protected)/layout.tsx + page.tsx + [id]/page.tsx、
 * つまり本物のNavRail/Header/Toolbar/Sidebar/Table/Pagination一式)を
 * 本物のブラウザで375/390/430pxのビューポートで描画し、横スクロールが
 * ゼロであることを実測するためのharness。
 *
 * `webServer`が`next dev`を起動する際、`env`で
 * `INVENTORY_E2E_FIXTURES=1`と`INVENTORY_E2E_AUTH_TOKEN`を渡す——この
 * 2つはlib/inventory/e2eFixtures.ts/lib/amplify/requireInventoryUser.ts
 * の二重ゲート(NODE_ENV!=='production'もこのconfig自体が`next dev`
 * を使うことで自動的に満たされる)を通すためのopt-inで、
 * amplify.yml/Amplify Consoleには一切登場しない。
 */
const E2E_AUTH_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

export default defineConfig({
  testDir: "./e2e",
  // `next dev`は初回アクセスのルートをその場でコンパイルする
  // (webServerのreadiness確認は/inventory/loginしか温めないため、
  // 保護ルート(/inventory本体)への最初のnavigationは30秒を超える
  // ことがある——実測で約31秒、実際のアプリの遅さではなくNext.js
  // devモード固有のコールドスタートコスト)。1回目のtestだけこの
  // コストを払うため、余裕を持って60秒に設定する。
  timeout: 60_000,
  fullyParallel: false,
  // 不具合修正指示書(2026-08-30)対応時に実際に踏んだ不具合: `webServer`は
  // 全spec fileで共有される単一の`next dev`プロセス。`fullyParallel:
  // false`はファイル内の直列化のみを保証し、ファイル間は既定で別workerが
  // 並行実行され得る——2 workerがこの同一dev serverへ「初回コンパイル
  // (コールドスタート)」のタイミングで同時にnavigationすると、webpackの
  // 同時コンパイルが競合し、`TypeError: Cannot read properties of null
  // (reading 'useContext')`(PathnameContext)というNext.js dev server側
  // の実クラッシュ(Server Error dialog)を引き起こすことを実際に
  // 再現・特定した——リダイレクト先URLの見た目上の不一致に見えるが、
  // 原因は本物のサーバー側render crashであり、timeoutを伸ばしても
  // 解決しない(実際に検証済み)。単一の共有dev serverへ複数workerで
  // 同時アクセスさせないよう、全spec fileを常に1 workerで直列実行する。
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    // /opt/pw-browsers/chromiumが事前installされている(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    // によりnpm install時の再ダウンロードを止めている)ため、それを
    // 明示的に指す — @playwright/testが探すデフォルトキャッシュ
    // パスと食い違ってもこのconfigだけで完結する。
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium",
    },
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100/inventory/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      INVENTORY_E2E_FIXTURES: "1",
      INVENTORY_E2E_AUTH_TOKEN: E2E_AUTH_TOKEN,
    },
  },
});

export { E2E_AUTH_TOKEN };
