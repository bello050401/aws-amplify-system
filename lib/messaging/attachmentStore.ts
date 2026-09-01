import "server-only";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

/**
 * 受信メッセージの添付(LINEの画像等)をBELLO側のS3へ保存する。
 *
 * ## なぜAmplify Storageのクライアントを使わないのか
 *
 * `aws-amplify/storage/server` の access ルールは Cognito Identity Pool
 * のロールで効く。ところがこの経路を呼ぶのは **LINEからのWebhook** で、
 * Cognitoのセッションが存在しない。同じ理由で webhookStore.ts も
 * Amplify Data ではなく生のDynamoDBクライアントを使っている ——
 * ここも同じ方針に揃え、SSRの実行ロールで直接S3へ置く。
 *
 * ## なぜ受信直後に保存するのか
 *
 * LINEのコンテンツは一定期間で取得できなくなる。表示のたびにLINEから
 * 取りに行く作りにすると、時間が経った画像が見られなくなる ——
 * 「あとで確認しよう」と思った問い合わせほど失われる。
 * 受信した時点で自前に持つ。
 *
 * ## 失敗しても会話を失わない
 *
 * 保存に失敗しても例外を投げず、結果を返す。呼び出し側はメッセージ自体は
 * 記録し、添付だけを FAILED として残す。画像が取れなかったことと、
 * 問い合わせが無かったことは全く違う。
 */

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
const BUCKET = process.env.MESSAGING_ATTACHMENT_BUCKET || process.env.STORAGE_BUCKET_NAME || "";

/** ADMINだけが読める prefix。inventory/* とは別にして、権限を混ぜない。 */
export const ATTACHMENT_PREFIX = "messaging/attachments";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({ region: REGION });
  return client;
}

export type AttachmentSaveResult =
  | { ok: true; storageKey: string; contentType: string; sizeBytes: number }
  | { ok: false; reason: string };

/** content-type から拡張子を決める。分からなければ拡張子なしで置く(中身は content-type が持つ)。 */
function extensionFor(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("pdf")) return ".pdf";
  return "";
}

export async function saveIncomingAttachment(params: {
  conversationId: string;
  externalMessageId: string;
  body: Uint8Array;
  contentType: string;
}): Promise<AttachmentSaveResult> {
  if (!BUCKET) {
    return { ok: false, reason: "添付の保存先バケットが設定されていません(MESSAGING_ATTACHMENT_BUCKET)。" };
  }
  // キーに externalMessageId を含めるのは、同じメッセージを再処理しても
  // 同じ場所へ書けるようにするため(LINEの再送で重複ファイルを作らない)。
  const key = `${ATTACHMENT_PREFIX}/${params.conversationId}/${params.externalMessageId}-${randomUUID().slice(0, 8)}${extensionFor(params.contentType)}`;

  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
    return { ok: true, storageKey: key, contentType: params.contentType, sizeBytes: params.body.byteLength };
  } catch (err) {
    // 保存できなかったことは記録するが、値そのものは出さない。
    console.error("[messaging/attachmentStore] 添付の保存に失敗", {
      conversationId: params.conversationId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { ok: false, reason: err instanceof Error ? err.message : "添付の保存に失敗しました。" };
  }
}
