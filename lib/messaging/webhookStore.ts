import "server-only";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/** 設定が揃っているか。揃っていなければ呼び出し側が「未設定」として扱えるようにする。 */
export function isWebhookStoreConfigured(): boolean {
  return Boolean(CONVERSATION_TABLE && MESSAGE_TABLE);
}

/**
 * 失敗の種別。**運用者が原因を切り分けるためだけの短い符号**で、
 * ARN・ロール名・テーブル名・本文といった中身は一切含めない。
 *
 * これを足した理由は、Amplify HostingのSSRログが有効になっておらず、
 * 500だけを見ても「テーブル名が渡っていない」のか「権限が無い」のか
 * 「別の障害」なのかが区別できなかったため。実際にこの切り分けができず
 * 一度デプロイをやり直している。
 */
export type WebhookStoreFailure = "TABLE_NOT_CONFIGURED" | "ACCESS_DENIED" | "TABLE_NOT_FOUND" | "OTHER";

export function classifyWebhookStoreFailure(err: unknown): WebhookStoreFailure {
  if (!CONVERSATION_TABLE || !MESSAGE_TABLE) return "TABLE_NOT_CONFIGURED";
  const name = err instanceof Error ? err.name : "";
  if (name === "AccessDeniedException") return "ACCESS_DENIED";
  if (name === "ResourceNotFoundException") return "TABLE_NOT_FOUND";
  return "OTHER";
}

export interface IncomingWebhookMessage {
  channel: MessageChannel;
  externalCustomerId: string;
  externalMessageId: string;
  body: string;
  externalSentAt: string;
  customerDisplayName?: string | null;
  /** 顧客名をどこから取ったか("LINE_PROFILE"等)。取得を試みた事実の記録。 */
  customerNameSource?: string | null;
  /** 顧客名の取得を試みた時刻。次に取り直すかの判断に使う。 */
  customerNameFetchedAt?: string | null;
  /** メッセージ種別。画像を「本文が空のテキスト」として捨てないために持つ。 */
  contentKind?: "TEXT" | "IMAGE" | "STICKER" | "FILE" | "OTHER";
  /** 添付をBELLO側へ保存できた場合のキー。 */
  attachmentStorageKey?: string | null;
  attachmentContentType?: string | null;
  attachmentSizeBytes?: number | null;
  /** NONE / PENDING / STORED / FAILED。取得失敗を会話の消失にしないための状態。 */
  attachmentStatus?: "NONE" | "PENDING" | "STORED" | "FAILED";
  attachmentError?: string | null;
}

export type RecordResult = { conversationId: string; messageId: string } | { deduped: true };

/**
 * この関数が外界に対して持っている依存の全て。
 *
 * 本番は下の `recordIncomingWebhookMessage` が実クライアント・実UUID・実時刻を
 * 詰めて渡す。テストは偽の `send` を渡して、DynamoDBへ実際に何を送るか
 * (どのテーブル・どのGSI・どの式)を検査する。この継ぎ目が無いと、
 * 「新規会話を作る/既存会話へ足す/再送を弾く」という**分岐そのもの**が
 * 実AWSでしか確かめられず、実質テスト不能になる。
 */
export interface WebhookStoreDeps {
  send: (command: unknown) => Promise<Record<string, unknown>>;
  conversationTable: string;
  messageTable: string;
  newId: () => string;
  now: () => string;
}

/** 既に取り込み済みか（LINEの再送で重複を作らないための判定）。 */
async function findExistingMessage(deps: WebhookStoreDeps, externalMessageId: string): Promise<boolean> {
  const res = (await deps.send(
    new QueryCommand({
      TableName: deps.messageTable,
      IndexName: MESSAGE_BY_EXTERNAL_ID_INDEX,
      KeyConditionExpression: "externalMessageId = :e",
      ExpressionAttributeValues: { ":e": externalMessageId },
      Limit: 1,
    }),
  )) as { Items?: unknown[] };
  return (res.Items?.length ?? 0) > 0;
}

/**
 * チャネルと顧客IDで既存の会話を探す。
 *
 * Conversationには (channel, externalCustomerId) のGSIが無いのでScanになる。
 * Webhook受信は1件ずつでスループットが小さく、会話数もInventoryのような
 * 規模にはならないため許容する。将来件数が増えたらGSIを足す。
 */
async function findConversation(
  deps: WebhookStoreDeps,
  channel: MessageChannel,
  externalCustomerId: string,
): Promise<Record<string, unknown> | null> {
  let key: Record<string, unknown> | undefined;
  do {
    const res = (await deps.send(
      new ScanCommand({
        TableName: deps.conversationTable,
        FilterExpression: "channel = :c AND externalCustomerId = :e",
        ExpressionAttributeValues: { ":c": channel, ":e": externalCustomerId },
        ExclusiveStartKey: key,
      }),
    )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
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
  return recordIncomingWebhookMessageWith(
    {
      send: (command) => ddb().send(command as never) as Promise<Record<string, unknown>>,
      conversationTable: CONVERSATION_TABLE,
      messageTable: MESSAGE_TABLE,
      newId: randomUUID,
      now: () => new Date().toISOString(),
    },
    params,
  );
}

/** 上の本体。依存を引数で受け取るので、テストから実AWS無しで通せる。 */
export async function recordIncomingWebhookMessageWith(
  deps: WebhookStoreDeps,
  params: IncomingWebhookMessage,
): Promise<RecordResult> {
  if (await findExistingMessage(deps, params.externalMessageId)) return { deduped: true };

  const now = deps.now();
  const preview = buildMessagePreview(params.body);
  const existing = await findConversation(deps, params.channel, params.externalCustomerId);

  let conversationId: string;
  if (!existing) {
    conversationId = deps.newId();
    await deps.send(
      new PutCommand({
        TableName: deps.conversationTable,
        Item: {
          id: conversationId,
          __typename: "Conversation",
          channel: params.channel,
          externalCustomerId: params.externalCustomerId,
          customerDisplayName: params.customerDisplayName ?? null,
          customerNameSource: params.customerNameSource ?? null,
          customerNameFetchedAt: params.customerNameFetchedAt ?? null,
          status: "WAITING_FOR_REPLY",
          unreadCount: 1,
          // 未読の正本はこのフラグ。unreadCountは件数の目安として残すが、
          // 「開いたら消える」判定はこちらで行う(0へ戻す経路が
          // これまでコード中に1つも無かった)。
          isUnread: true,
          lastReadAt: null,
          // 業務ステータスの初期値。既読/未読とは別軸。
          workflowStatus: "NEW",
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
    await deps.send(
      new UpdateCommand({
        TableName: deps.conversationTable,
        Key: { id: conversationId },
        // 新着が来たら必ず未読へ戻す(§5「新しい顧客メッセージが追加
        // された場合は再び未読にする」)。業務ステータスには触れない ——
        // 「大原確認」中に新着が来ても、確認待ちであることは変わらない。
        UpdateExpression:
          "SET #s = :s, needsReply = :n, unreadCount = :u, isUnread = :unread, lastMessagePreview = :p, lastMessageAt = :m, lastIncomingAt = :i, updatedAt = :t, updatedBy = :b" +
          (params.customerDisplayName ? ", customerDisplayName = :dn, customerNameSource = :dns, customerNameFetchedAt = :dnf" : ""),
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": status,
          ":n": needsReply,
          ":u": (Number(existing.unreadCount) || 0) + 1,
          ":unread": true,
          ":p": preview,
          ":m": params.externalSentAt,
          ":i": params.externalSentAt,
          ":t": now,
          ":b": "LINE受信",
          ...(params.customerDisplayName
            ? {
                ":dn": params.customerDisplayName,
                ":dns": params.customerNameSource ?? null,
                ":dnf": params.customerNameFetchedAt ?? now,
              }
            : {}),
        },
      }),
    );
  }

  const messageId = deps.newId();
  await deps.send(
    new PutCommand({
      TableName: deps.messageTable,
      Item: {
        id: messageId,
        __typename: "Message",
        conversationId,
        externalMessageId: params.externalMessageId,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        body: params.body,
        contentType: params.contentKind === "IMAGE" ? "image" : "text",
        contentKind: params.contentKind ?? "TEXT",
        attachmentStorageKey: params.attachmentStorageKey ?? null,
        attachmentContentType: params.attachmentContentType ?? null,
        attachmentSizeBytes: params.attachmentSizeBytes ?? null,
        attachmentStatus: params.attachmentStatus ?? "NONE",
        attachmentError: params.attachmentError ?? null,
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
