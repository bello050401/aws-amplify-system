/**
 * scripts/qa/server-only-noop-loader.mjs のCJS版。
 *
 * tsxはこのリポジトリのpackage.jsonに `"type": "module"` が無いため
 * .tsファイルをCJSとして変換する——`import "server-only"` は
 * `require("server-only")` になり、NodeネイティブのCJSローダー
 * (Module._load)を通る。ESM側の module customization hooks
 * (server-only-noop-loader.mjs)はこの経路には効かないため、
 * Module._load を同じ方針(node_modulesは一切書き換えない・
 * "server-only" というrequest文字列だけを対象にする)で差し替える。
 *
 * 使い方: node --require ./scripts/qa/server-only-noop-require-hook.cjs \
 *              --import tsx <script>.ts
 */
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "server-only") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
