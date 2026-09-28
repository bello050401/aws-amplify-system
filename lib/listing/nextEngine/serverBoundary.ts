/** Next Engine tokens must stay between BELLO's server and the official API. */
export function assertNextEngineServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new Error("ネクストエンジンの認証情報はサーバー側でのみ使用できます。");
  }
}
