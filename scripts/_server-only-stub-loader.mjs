/**
 * scripts/with-server-only-stub-native.cjs 専用の、"server-only"だけを
 * プロセス内で無害化するロードhook。
 *
 * 【disk上のnode_modulesを書き換えない】以前はnode_modules/server-only/
 * index.js を一時的に上書きしてから実行し、終了後に戻していた。これは
 * 共有のnode_modules(他のworktree・並行実行中の別プロセスと共有されうる)
 * への書き込みを伴い、書き換え中に別プロセスが読むと壊れた内容を読む
 * レースになりうる。このhookは"server-only"という**指定子の解決結果**
 * だけをこのNodeプロセスの中だけで差し替える。diskには一切触れない。
 *
 * "@/…"エイリアス・拡張子省略の相対importの解決は
 * scripts/_ts-extension-loader.mjs にそのまま委譲する(再実装しない)。
 *
 * Usage: node --experimental-strip-types \
 *   --experimental-loader ./scripts/_server-only-stub-loader.mjs \
 *   --experimental-test-module-mocks <script.ts>
 */
import { resolve as extResolve } from "./_ts-extension-loader.mjs";

const STUB_URL = "server-only-stub:server-only";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  return extResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return { format: "module", source: "export default {};\n", shortCircuit: true };
  }
  return nextLoad(url, context);
}
