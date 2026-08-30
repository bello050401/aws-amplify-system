import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * BELLO統合業務OS指示書(2026-08-30) §51/§87: LINE Webhook署名検証
 * (純粋関数 — cryptoのみ、AWS/Amplifyへは一切触れない)。
 *
 * LINE公式ドキュメント(2026-08-30 WebSearchで確認: 「HMAC-SHA256を
 * 受信したWebhookリクエストボディを入力データ、Channel Secretを
 * ハッシュキーとして使い署名を生成し、`x-line-signature`ヘッダの値と
 * 比較する」)通りの実装。ボディ文字列は受信した生のバイト列(JSON.parse
 * 後の値ではない)をそのまま使うこと — 呼び出し元(app/api/line/webhook/
 * route.tsのroute handler)がreq.text()で取得した生文字列をそのまま渡す
 * 契約になっている(公式ドキュメントの警告: 「署名検証前にボディを
 * 変更・デシリアライズしてはならない」)。
 */
export function verifyLineSignature(rawBody: string, signatureHeader: string | null, channelSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  // 長さが異なるとtimingSafeEqualが例外を投げるため先にチェックする
  // (長さの違い自体は秘密情報ではないので、ここでの早期returnはタイミ
  // ング攻撃の対象にならない)。
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
