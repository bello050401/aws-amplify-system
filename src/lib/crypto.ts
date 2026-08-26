import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Personal API Access Token など機密情報をDBに保存する前に暗号化するためのユーティリティ。
 * AES-256-GCM を使用。鍵は環境変数 ENCRYPTION_KEY (base64, 32byte) から取得する。
 *
 * 絶対にログ・エラーメッセージへ平文/暗号文を出力しないこと（指示書32, 39, 56項）。
 */

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).");
  }
  return key;
}

/** 平文を暗号化し、"iv:authTag:cipherText" (すべてbase64) の1文字列で返す。 */
export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(
    ":",
  );
}

/** encryptSecret() で生成した文字列を復号する。 */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const [ivB64, authTagB64, dataB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error("Invalid encrypted payload format.");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** ログ等に出す際、トークンをマスクする（先頭4文字のみ表示）。 */
export function maskSecret(plainText: string): string {
  if (plainText.length <= 4) return "****";
  return `${plainText.slice(0, 4)}${"*".repeat(Math.max(4, plainText.length - 4))}`;
}
