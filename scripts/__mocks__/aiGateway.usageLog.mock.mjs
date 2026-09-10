/**
 * scripts/verify-ai-gateway-recording.ts 専用fixture。
 *
 * lib/ai/gateway/gateway.ts が相対importする ./usageLog を差し替える。
 * 本物のusageLog.tsは"server-only"に加え@/lib/amplify/dataClient
 * (next/headers・@aws-amplify/adapter-nextjs等)へ依存しており、DBへの
 * 実書き込みを一切発生させたくないこのテストでは境界として扱う。
 *
 * recordAIUsageに渡された入力(input)をそのまま記録するだけ —— 実際に
 * gateway.ts/router.tsが「何を渡してくるか」をテスト側で検証する。
 */

export const calls = [];

// ESM の named export は呼び出し元からは読み取り専用のlive bindingで、
// 外からrecordAIUsage自体を差し替えることはできない(モジュール名前空間
// オブジェクトのプロパティは再定義不可)。「一時的に失敗させる」テストが
// 必要な場合のために、実体は差し替え可能な内部関数へ委譲する形にする。
let impl = defaultImpl;

async function defaultImpl(input) {
  calls.push(input);
}

export async function recordAIUsage(input) {
  return impl(input);
}

/** テストから一時的に振る舞いを差し替える(例: 書き込み失敗を模す)。 */
export function __setImpl(fn) {
  impl = fn;
}

export function __resetImpl() {
  impl = defaultImpl;
}

export function __reset() {
  calls.length = 0;
  impl = defaultImpl;
}
