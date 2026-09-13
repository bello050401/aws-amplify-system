// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// scripts/with-server-only-stub.cjs と同じ理由(node_modules/server-only
// は通常のCJS requireでは無条件にthrowする実装)——ここではそもそも
// node_modulesが実体として存在しない([[qa-worktree-tooling-limits]])
// ため、`server-only`という指定子自体をこのファイルへ差し替える。
module.exports = {};
