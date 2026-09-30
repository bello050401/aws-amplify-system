import { assertNextEngineServerRuntime } from "./serverBoundary";
import type { NextEngineAppConfiguration } from "./appConfiguration";

type TokenPair = { accessToken: string; refreshToken: string };

/** Do not report connection until the token pair is persisted and read back. */
export async function completeNextEngineLaunch(
  input: NextEngineAppConfiguration & { uid: string; state: string },
  deps: {
    preflight: () => Promise<unknown>;
    exchange: (input: NextEngineAppConfiguration & { uid: string; state: string }) => Promise<TokenPair>;
    verifyConfiguration: () => Promise<NextEngineAppConfiguration | null>;
    save: (tokens: TokenPair) => Promise<void>;
    readBack: () => Promise<TokenPair | null>;
  },
): Promise<void> {
  assertNextEngineServerRuntime();
  if (!input.uid?.trim() || !input.state?.trim()) throw new Error("ネクストエンジンの起動情報が不足しています。");
  await deps.preflight();
  const received = await deps.exchange(input);
  const current = await deps.verifyConfiguration();
  if (!current || current.credentialVersionId !== input.credentialVersionId ||
      current.expectedCompanyNeId !== input.expectedCompanyNeId || current.clientId !== input.clientId) {
    throw new Error("ネクストエンジンのアプリ設定が変更されました。接続をやり直してください。");
  }
  await deps.save(received);
  const saved = await deps.readBack();
  const afterSave = await deps.verifyConfiguration();
  if (!saved || saved.accessToken !== received.accessToken || saved.refreshToken !== received.refreshToken ||
      !afterSave || afterSave.credentialVersionId !== input.credentialVersionId ||
      afterSave.expectedCompanyNeId !== input.expectedCompanyNeId || afterSave.clientId !== input.clientId) {
    throw new Error("ネクストエンジンの接続情報を保存後に確認できませんでした。");
  }
}
