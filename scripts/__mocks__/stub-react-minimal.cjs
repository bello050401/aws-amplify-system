// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/amplify/requestCache.ts が`import * as React from "react"`する
// (React.cacheが無ければ素通しするよう既に設計済み——同ファイルの
// コメント参照)。このworktreeには実物の"react"パッケージが無いため、
// 空実装で十分(cacheが無い扱いになり、requestCacheは単に毎回実行する
// だけになる——結果は変わらない、遅くなるだけ)。
module.exports = {};
