/**
 * Mercari Shops GraphQL エンドポイント定義(BELLO統合改修 master指示書
 * Phase D — origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * integrations/mercari-shops/endpoints.tsから移植、ロジック無変更)。
 * URLはこの1箇所のみに書き、他の場所にハードコードしない。
 */

export type MercariEnvironment = "sandbox" | "production";

const ENDPOINTS: Record<MercariEnvironment, string> = {
  sandbox: "https://api.mercari-shops-sandbox.com/v1/graphql",
  production: "https://api.mercari-shops.com/v1/graphql",
};

export function getMercariEnvironment(): MercariEnvironment {
  const raw = (process.env.MERCARI_ENV ?? "sandbox").toLowerCase();
  if (raw === "production") return "production";
  if (raw !== "sandbox") {
    console.warn(`Unknown MERCARI_ENV="${raw}", falling back to "sandbox".`);
  }
  return "sandbox";
}

export function getMercariEndpoint(env: MercariEnvironment = getMercariEnvironment()): string {
  return ENDPOINTS[env];
}
