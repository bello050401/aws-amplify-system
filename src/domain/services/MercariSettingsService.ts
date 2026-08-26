import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getMercariEnvironment } from "@/integrations/mercari-shops/endpoints";

/**
 * Personal API Access Token を含む /settings/mercari 用の設定管理。
 * トークンは常に暗号化してAppSettingへ保存し、平文はDB/ログに残さない
 * （指示書32, 56項）。環境(sandbox/production)ごとに別キーで保存する。
 */

function tokenSettingKey(env: string): string {
  return `mercari.accessToken.${env}`;
}

export async function saveMercariAccessToken(token: string, env = getMercariEnvironment()) {
  const encrypted = encryptSecret(token);
  await prisma.appSetting.upsert({
    where: { key: tokenSettingKey(env) },
    create: { key: tokenSettingKey(env), value: encrypted },
    update: { value: encrypted },
  });
}

export async function hasMercariAccessToken(env = getMercariEnvironment()): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: tokenSettingKey(env) } });
  return !!row;
}

/**
 * 復号済みトークンを取得する。DB未設定の場合はエラーを投げる。
 * 呼び出し結果を絶対にログ出力しないこと。
 */
export async function getMercariAccessToken(env = getMercariEnvironment()): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: tokenSettingKey(env) } });
  if (!row) {
    throw new Error(
      `Mercari Shops Personal API Access Token is not configured for "${env}". Set it at /settings/mercari.`,
    );
  }
  return decryptSecret(row.value);
}
