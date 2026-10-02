import "server-only";

import { getNextEngineAppConfiguration, type NextEngineAppConfiguration } from "./appConfiguration";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { readNextEngineTokens, saveNextEngineTokens, type NextEngineTokenPair } from "./tokenStore";

type Services = {
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens: (binding: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  saveTokens: (tokens: NextEngineTokenPair, binding: NextEngineAppConfiguration) => Promise<void>;
};

const sameBinding = (left: NextEngineAppConfiguration | null, right: NextEngineAppConfiguration) =>
  !!left && left.clientId === right.clientId && left.clientSecret === right.clientSecret &&
  left.expectedCompanyNeId === right.expectedCompanyNeId && left.credentialVersionId === right.credentialVersionId;

/** Keep read-only NE queries within the current company and credential version. */
export async function withBoundNextEngineRead<T>(
  run: (tokens: NextEngineTokenPair, persist: (tokens: NextEngineTokenPair) => Promise<void>,
    binding: NextEngineAppConfiguration) => Promise<T>,
  overrides: Partial<Services> = {},
): Promise<T> {
  assertNextEngineServerRuntime();
  const services: Services = {
    configuration: getNextEngineAppConfiguration, readTokens: readNextEngineTokens,
    saveTokens: saveNextEngineTokens, ...overrides,
  };
  const binding = await services.configuration();
  if (!binding) throw new Error("ネクストエンジンのアプリ設定が必要です。");
  const assertBinding = async () => {
    if (!sameBinding(await services.configuration(), binding)) {
      throw new Error("ネクストエンジンの接続設定が変更されました。");
    }
  };
  const tokens = await services.readTokens(binding);
  if (!tokens) throw new Error("ネクストエンジンに接続してください。");
  await assertBinding();
  const result = await run(tokens, async next => {
    await assertBinding();
    await services.saveTokens(next, binding);
  }, binding);
  await assertBinding();
  return result;
}
