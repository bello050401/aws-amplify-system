/**
 * scripts/qa/server-only-noop-loader.mjs をNodeのmodule customization
 * hookとして登録するpreloadエントリ。使い方:
 *
 *   node --import tsx --import ./scripts/qa/server-only-noop-hook.mjs <script>.ts
 *
 * node_modulesは一切書き換えない。このファイルとserver-only-noop-loader.mjs
 * はQA検証専用で、アプリのビルド・実行経路からは参照されない。
 */
import { register } from "node:module";

register("./server-only-noop-loader.mjs", import.meta.url);
