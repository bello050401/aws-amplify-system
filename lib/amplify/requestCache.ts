import * as React from "react";

/**
 * 「1リクエストの中では1回だけ実行する」を、React の cache() があれば
 * それで行い、無ければ素通しする。
 *
 * ── なぜ直接 import { cache } from "react" と書かないのか ──────────
 *
 * package.json の react は 18.3.1 で、**このバージョンは cache を
 * export していない**(`typeof require("react").cache === "undefined"`
 * で確認済み)。cache を提供しているのは Next.js が App Router 用に
 * 内部で差し替えている canary ビルドのほう。
 *
 * そのため直接 import すると、
 *
 *   ・`next build` / 実行時 … Next の React が解決されるので動く
 *   ・scripts/verify-*.ts   … 素の react が解決されて
 *                             「cache is not a function」で落ちる
 *
 * という食い違いが起きる。実際、それでリポジトリの検証スクリプトが
 * 1本落ちた。ここで一段かませて、どちらの文脈でも動くようにする。
 *
 * 重複排除が効かない文脈では、単に毎回実行されるだけで結果は同じ。
 * 遅くなることはあっても、間違うことはない。
 */
export function requestCache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const cache = (React as unknown as { cache?: <F>(f: F) => F }).cache;
  return typeof cache === "function" ? cache(fn) : fn;
}
