/**
 * Mercari Shops GraphQL エンドポイント定義。
 * URLはこの1箇所のみに書き、他の場所にハードコードしない（指示書33項）。
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
