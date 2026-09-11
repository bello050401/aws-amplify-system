#!/usr/bin/env node
/**
 * scripts/with-server-only-stub.cjs と同じ目的(テストから "server-only"
 * マーク付きモジュールを読めるようにする)だが、node_modules/tsx を経由
 * せず、Node組み込みのTypeScript型ストリップ(--experimental-strip-types)
 * とscripts/_ts-extension-loader.mjsだけで実行する。
 *
 * 【なぜtsx経由にしないか】tsxのCLIは対象スクリプトを別プロセスで動かす
 * 経路を持ち、その経路では起動時に付けた実験的フラグ
 * (--experimental-test-module-mocks)が対象プロセスまで伝わらない
 * (実測: tsx経由だと `mock.module is not a function` になる)。
 * `node:test`のモジュールモック(mock.module)は @/lib/shipping/service の
 * ような実DynamoDB接続モジュールを、実クラウドへ繋がず境界だけ差し替えて
 * 検証するのに使うため、このフラグが確実に対象スクリプトへ渡る実行経路が
 * 要る。with-server-only-stub.cjs 自体を書き換えると、他の多くの
 * verify:* スクリプト(tsxのJSX/複雑な構文サポートに依存しうる)に影響する
 * ため、この用途専用の別ランナーとして追加する。
 *
 * 【"server-only"の無害化はdisk上のnode_modulesを書き換えない】
 * 以前の実装はここでnode_modules/server-only/index.jsを一時的に上書き
 * していたが、それは共有のnode_modules(他のworktree・並行実行中の別
 * プロセスと共有されうる)への書き込みを伴う。scripts/
 * _server-only-stub-loader.mjs (Nodeのモジュールカスタマイズフック)へ
 * 差し替えた —— "server-only"という**指定子の解決結果**をこのNode
 * プロセスの中だけで無害化するだけで、diskには一切触れない
 * (2026-09-12 QA是正: 「共有node_modulesを書換える新native wrapperは
 * 不採用」という指摘への対応)。
 *
 * Usage: node scripts/with-server-only-stub-native.cjs <script.ts> [args...]
 */
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/with-server-only-stub-native.cjs <script.ts> [args...]");
  process.exit(1);
}

const loaderUrl = pathToFileURL(path.join(__dirname, "_server-only-stub-loader.mjs")).href;

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--experimental-loader",
    loaderUrl,
    "--experimental-test-module-mocks",
    target,
    ...process.argv.slice(3),
  ],
  {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  },
);
process.exit(result.status ?? 1);
