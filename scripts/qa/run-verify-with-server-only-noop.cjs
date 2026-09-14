/**
 * QA検証専用。scripts/with-server-only-stub.cjs は共有 node_modules/server-only/index.js
 * の中身を一時的に書き換えてから復元する方式だが、このworktreeのnode_modulesは本体
 * リポジトリへのjunction(共有)であり、この検証セッションではその方式は許可されない
 * (「共有node_modulesは変更しない」)。
 *
 * tsx自身のCLI(node_modules/tsx/dist/cli.mjs)は自分の子プロセスをspawnしてその中で
 * 対象スクリプトを実行するため、親プロセスへの `node --require <hook>` は子プロセス
 * まで届かない(scripts/qa/server-only-noop-require-hook.cjs 単体を --require しても
 * 対象スクリプトには効かないことを実測で確認済み)。子プロセスもNode標準の
 * NODE_OPTIONS 環境変数は読むため、ここではそれを使って
 * server-only-noop-require-hook.cjs (Module._load を "server-only" という
 * request文字列だけに絞って差し替えるフック)を子プロセスにも伝播させる。
 * node_modulesは一切書き換えない。既存のNODE_OPTIONSがあれば末尾に追記する。
 *
 * 使い方: node scripts/qa/run-verify-with-server-only-noop.cjs <script.ts> [args...]
 */
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/qa/run-verify-with-server-only-noop.cjs <script.ts> [args...]");
  process.exit(1);
}

const hookPath = path.join(__dirname, "server-only-noop-require-hook.cjs");
const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
process.env.NODE_OPTIONS = `${existingNodeOptions} --require ${hookPath}`.trim();

const tsxCliPath = path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
process.argv = [process.argv[0], "tsx", target, ...process.argv.slice(3)];
require(tsxCliPath);
