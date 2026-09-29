import { assertNextEngineServerRuntime } from "./serverBoundary";

export type NextEngineAppConfiguration = {
  clientId: string;
  clientSecret: string;
  expectedCompanyNeId: string;
};

/** Server-only configuration. Missing values keep the connection disabled. */
export function getNextEngineAppConfiguration(
  env: Record<string, string | undefined> = {
    NEXT_ENGINE_CLIENT_ID: process.env.NEXT_ENGINE_CLIENT_ID,
    NEXT_ENGINE_CLIENT_SECRET: process.env.NEXT_ENGINE_CLIENT_SECRET,
    NEXT_ENGINE_COMPANY_NE_ID: process.env.NEXT_ENGINE_COMPANY_NE_ID,
  },
): NextEngineAppConfiguration | null {
  assertNextEngineServerRuntime();
  const clientId = env.NEXT_ENGINE_CLIENT_ID?.trim();
  const clientSecret = env.NEXT_ENGINE_CLIENT_SECRET?.trim();
  const expectedCompanyNeId = env.NEXT_ENGINE_COMPANY_NE_ID?.trim();
  if (!clientId || !clientSecret || !expectedCompanyNeId) return null;
  if (/\s/.test(clientId) || /\s/.test(clientSecret) || !/^[0-9]+$/.test(expectedCompanyNeId)) {
    throw new Error("ネクストエンジンのサーバー側設定が不正です。");
  }
  return { clientId, clientSecret, expectedCompanyNeId };
}
