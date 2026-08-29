import "server-only";
import { getMercariTokenFromSecretsManager } from "./secretStore";

/**
 * BELLO統合改修 master指示書 Phase D — lib/zaico/client.tsの
 * getZaicoApiToken/isZaicoConnected/getZaicoTokenSourceと同一の設計
 * (AWS Secrets Manager優先、無ければサーバー環境変数
 * MERCARI_ACCESS_TOKENへフォールバック)をMercari用に用意したもの。
 * 値はこのファイルの戻り値としてのみ存在し、呼び出し元
 * (lib/listing/mercari/client.tsのMercariShopsClient)がAuthorization
 * ヘッダへ直接渡す以外の用途では使わない。
 */
export async function getMercariAccessToken(): Promise<string> {
  const fromSecretsManager = await getMercariTokenFromSecretsManager();
  const token = fromSecretsManager ?? process.env.MERCARI_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Mercari Shops Personal API Access Tokenが設定されていません。設定画面のEC出品タブから登録するか、サーバー環境変数MERCARI_ACCESS_TOKENを設定してください（値そのものはログに出力されません）。",
    );
  }
  return token;
}

export async function isMercariConnected(): Promise<boolean> {
  if (await getMercariTokenFromSecretsManager()) return true;
  return Boolean(process.env.MERCARI_ACCESS_TOKEN);
}

export type MercariTokenSource = "secrets-manager" | "env-fallback" | "unconfigured";

export async function getMercariTokenSource(): Promise<MercariTokenSource> {
  if (await getMercariTokenFromSecretsManager()) return "secrets-manager";
  if (process.env.MERCARI_ACCESS_TOKEN) return "env-fallback";
  return "unconfigured";
}
