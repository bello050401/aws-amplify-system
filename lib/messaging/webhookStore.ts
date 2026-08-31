import "server-only";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
// 純粋ロジックのみを取り込む。service.ts は "server-only" と
// serverDataClient(Cookie前提)を引き込むため、ここからは触らない。
import { buildMessagePreview, deriveNeedsReply, deriveConversationStatus } from "./conversationStatus";
import type { MessageChannel } from "./types";

/**
 * Webhook受信メッセージの保存（DynamoDB直接アクセス）。
 *
 * ## なぜ `recordIncomingMessage` をそのまま使えないのか
 *
 * `lib/messaging/service.ts` の `recordIncomingMessage` は
 * `serverDataClient`(Cookieベース)＋`authMode: "userPool"` でAppSyncを叩く。
 * これは**ログイン中のユーザーがいる**ことを前提にした経路である。
 *
 * ところがLINE webhookはLINEプラットフォームからの**未認証POST**で、
 * Cookieもユーザーセッションも存在しない。そのため保存が必ず失敗し、
 * ハンドラは500(`{ok:false,failed:1}`)を返していた——つまり
 * **LINEから届いたメッセージは一件もBELLOに入らなかった**。
 * 署名付きの本物のリクエストを送って実際に再現している(2026-08-31)。
 *
 * さらに `Conversation`/`Message` の認可はCognitoグループのみで、
 * IAMもguestも無い。**設計上、未認証の経路からは書き込めない**。
 *
 * ## 採った方法
 *
 * このリポジトリには既に「実行ロールの資格情報でDynamoDBを直接読み書き
 * する」バックグラウンド処理が3つある(zaico-sync-worker /
 * image-processing-worker / pricing-scheduler)。同じ方式を踏襲する。
 * AppSyncのスキーマ(`amplify/data/resource.ts`)には手を触れず、認可境界も
 * 広げない。
 *
 * `recordIncomingMessage` は画面側の経路として**そのまま残す**。同じ処理を
 * 2箇所に持つことになるが、認証前提が根本的に違う2つの経路を1つの関数へ
 * 押し込めるより、境界を分けたほうが誤りが起きにくい。
 *
 * ## 冪等性
 *
 * LINEは2xxを返さなかったイベントを再送する。`externalMessageId` のGSIで
 * 既存を検出して `{deduped:true}` を返すので、再送で重複は生まれない。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";

/**
 * テーブル名。Amplifyが生成する `<Model>-<apiId>-<envName>` を
 * 環境変数で受け取る（workerたちがaddEnvironmentで受け取っているのと同じ考え方だが、
 * SSRコンピュートはCDK管理外なのでAmplifyアプリの環境変数として設定する）。
 */
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE_NAME;
const MESSAGE_TABLE = process.env.MESSAGE_TABLE_NAME;

/** Amplifyが作るGSIの名前。`index("externalMessageId")` から生成される。 */
const MESSAGE_BY_EXTERNAL_ID_INDEX = "messagesByExternalMessageId";
const CONVERSATION_BY_STATUS_INDEX = "conversationsByStatus";

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/** 設定が揃っているか。揃っていなければ呼び出し側が「未設定」として扱えるようにする。 */
export function isWebhookStoreConfigured(): boolean {
  return Boolean(CONVERSATION_TABLE && MESSAGE_TABLE);
}

export interface IncomingWebhookMessage {
  channel: MessageChannel;
  externalCustomerId: string;
  externalMessageId: string;
  body: string;
  externalSentAt: string;
  customerDisplayName?: string | null;
}

export type RecordResult = { conversationId: string; messageId: string } | { deduped: true };

/** 既に取り込み済みか（LINEの再送で重複を作らないための判定）。 */
async function findExistingMessage(externalMessageId: string): Promise<boolean> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: MESSAGE_TABLE,
      IndexName: MESSAGE_BY_EXTERNAL_ID_INDEX,
      KeyConditionExpression: "externalMessageId = :e",
      ExpressionAttributeValues: { ":e": externalMessageId },
      Limit: 1,
    }),
  );
  return (res.Items?.length ?? 0) > 0;
}

/**
 * チャネルと顧客IDで既存の会話を探す。
 *
 * Conversationには (channel, externalCustomerId) のGSIが無いのでScanになる。
 * Webhook受信は1件ずつでスループットが小さく、会話数もInventoryのような
 * 規模にはならないため許容する。将来件数が増えたらGSIを足す。
 */
async function findConversation(channel: MessageChannel, externalCustomerId: string): Promise<Record<string, unknown> | null> {
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb().send(
      new ScanCommand({
        TableName: CONVERSATION_TABLE,
        FilterExpression: "channel = :c AND externalCustomerId = :e",
        ExpressionAttributeValues: { ":c": channel, ":e": externalCustomerId },
        ExclusiveStartKey: key,
      }),
    );
    const hit = res.Items?.[0];
    if (hit) return hit;
    key = res.LastEvaluatedKey;
  } while (key);
  return null;
}

/**
 * 受信メッセージを保存する。
 *
 * 失敗は握りつぶさず投げる。呼び出し元(webhookハンドラ)が500を返し、
 * LINEに再送させるため——2xxを返すとLINEは再送せず、記録できなかった
 * メッセージはそのまま失われる。
 */
export async function recordIncomingWebhookMessage(params: IncomingWebhookMessage): Promise<RecordResult> {
  if (!CONVERSATION_TABLE || !MESSAGE_TABLE) {
    throw new Error(
      "受信メッセージ保存用のテーブル名が未設定です（CONVERSATION_TABLE_NAME / MESSAGE_TABLE_NAME）。",
    );
  }

  if (await findExistingMessage(params.externalMessageId)) return { deduped: true };

  const now = new Date().toISOString();
  const preview = buildMessagePreview(params.body);
  const existing = await findConversation(params.channel, params.externalCustomerId);

  let conversationId: string;
  if (!existing) {
    conversationId = randomUUID();
    await ddb().send(
      new PutCommand({
        TableName: CONVERSATION_TABLE,
        Item: {
          id: conversationId,
          __typename: "Conversation",
          channel: params.channel,
          externalCustomerId: params.externalCustomerId,
          customerDisplayName: params.customerDisplayName ?? null,
          status: "WAITING_FOR_REPLY",
          unreadCount: 1,
          needsReply: true,
          priority: "NORMAL",
          lastMessagePreview: preview,
          lastMessageAt: params.externalSentAt,
          lastIncomingAt: params.externalSentAt,
          createdBy: "LINE受信",
          updatedBy: "LINE受信",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  } else {
    conversationId = String(existing.id);
    const needsReply = deriveNeedsReply(params.externalSentAt, (existing.lastOutgoingAt as string | null) ?? null);
    const status = deriveConversationStatus(needsReply, true, existing.status as never);
    await ddb().send(
      new UpdateCommand({
        TableName: CONVERSATION_TABLE,
        Key: { id: conversationId },
        UpdateExpression:
          "SET #s = :s, needsReply = :n, unreadCount = :u, lastMessagePreview = :p, lastMessageAt = :m, lastIncomingAt = :i, updatedAt = :t, updatedBy = :b",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": status,
          ":n": needsReply,
          ":u": (Number(existing.unreadCount) || 0) + 1,
          ":p": preview,
          ":m": params.externalSentAt,
          ":i": params.externalSentAt,
          ":t": now,
          ":b": "LINE受信",
        },
      }),
    );
  }

  const messageId = randomUUID();
  await ddb().send(
    new PutCommand({
      TableName: MESSAGE_TABLE,
      Item: {
        id: messageId,
        __typename: "Message",
        conversationId,
        externalMessageId: params.externalMessageId,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        body: params.body,
        contentType: "text",
        externalSentAt: params.externalSentAt,
        deliveryStatus: "RECEIVED",
        aiGenerated: false,
        createdBy: "LINE受信",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return { conversationId, messageId };
}

export { CONVERSATION_BY_STATUS_INDEX };
