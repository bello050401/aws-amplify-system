import "server-only";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
// 純粋ロジックのみを取り込む。service.ts は "server-only" と
// serverDataClient(Cookie前提)を引き込むため、ここからは触らない。
import { buildMessagePreview, deriveNeedsReply, deriveConversationStatus } from "./conversationStatus";
import { decideConversationLink, type ConversationCandidate } from "./conversationLink";
import { parseConversationContext } from "@/lib/inquiry/conversationContext";
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
  /**
   * チャネル側の顧客ID(LINEの source.userId)。
   *
   * **これが取れるなら、これだけで会話を決める。** 空文字を渡してきた場合は
   * 表示名による補助照合へ落ちる(2026-09-03 追加指示 §19)。
   */
  externalCustomerId: string;
  /** チャネル側の会話ID(メルカリShopsの inquiryId 等)。最も強い識別子。 */
  externalConversationId?: string | null;
  /** 本文から取れたBASE商品ID。表示名照合のときに文脈の継続性を見るのに使う。 */
  baseItemIds?: string[];
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

export type RecordResult =
  | { conversationId: string; messageId: string }
  | {
      deduped: true;
      /**
       * 既に取り込まれていた行のID。GSIの射影に含まれていれば入る。
       * 呼び出し側はこれを使って、解析・通知だけをやり直せる
       * (findExistingMessage のコメント参照)。
       */
      conversationId?: string;
      messageId?: string;
    };

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

/**
 * 取り込み済みかを調べ、**見つかったらその行のIDも返す**。
 *
 * 真偽値だけを返していたときは、再送で弾いた時点で
 * conversationId/messageId が分からず、呼び出し側が「このメッセージに
 * ついて後続処理(解析・通知)をやり直す」ことができなかった。
 *
 * これは実際に穴になる: 初回の受信で保存までは成功し、その後の解析・通知が
 * 途中で落ちた(実行時間の上限、AIの失敗)場合、LINEは再送してくるが、
 * こちらは「重複」とだけ判断して**通知を作らないまま終わる**。
 * 保存済みのメッセージは画面には出るが、LINE通知は永遠に来ない。
 * IDを返せば、再送を「やり直しの機会」として使える。
 */
async function findExistingMessage(
  deps: WebhookStoreDeps,
  externalMessageId: string,
): Promise<{ conversationId?: string; messageId?: string } | null> {
  const res = (await deps.send(
    new QueryCommand({
      TableName: deps.messageTable,
      IndexName: MESSAGE_BY_EXTERNAL_ID_INDEX,
      KeyConditionExpression: "externalMessageId = :e",
      ExpressionAttributeValues: { ":e": externalMessageId },
      Limit: 1,
    }),
  )) as { Items?: Record<string, unknown>[] };
  const item = res.Items?.[0];
  if (!item) return null;
  // GSIの射影に含まれていない可能性を考えて、取れなければ undefined のまま返す
  // (呼び出し側は「IDが無い重複」として、これまでどおり何もしない)。
  return {
    conversationId: typeof item.conversationId === "string" ? item.conversationId : undefined,
    messageId: typeof item.id === "string" ? item.id : undefined,
  };
}

/**
 * 条件に合う会話をすべて集める。
 *
 * Conversationには (channel, externalCustomerId) のGSIが無いのでScanになる。
 * Webhook受信は1件ずつでスループットが小さく、会話数もInventoryのような
 * 規模にはならないため許容する。将来件数が増えたらGSIを足す。
 */
async function scanConversations(
  deps: WebhookStoreDeps,
  filterExpression: string,
  values: Record<string, unknown>,
  names?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = (await deps.send(
      new ScanCommand({
        TableName: deps.conversationTable,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: values,
        ...(names ? { ExpressionAttributeNames: names } : {}),
        ExclusiveStartKey: key,
      }),
    )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
    out.push(...(res.Items ?? []));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

function str(row: Record<string, unknown>, field: string): string | null {
  const v = row[field];
  return typeof v === "string" && v !== "" ? v : null;
}

/** 会話行を、結合判定が要る形へ落とす。 */
function toCandidate(row: Record<string, unknown>): ConversationCandidate {
  const context = parseConversationContext(str(row, "inquiryContext"));
  return {
    id: String(row.id),
    channel: String(row.channel),
    externalCustomerId: str(row, "externalCustomerId"),
    externalConversationId: str(row, "externalConversationId"),
    customerDisplayName: str(row, "customerDisplayName"),
    lastMessageAt: str(row, "lastMessageAt"),
    lastOutgoingAt: str(row, "lastOutgoingAt"),
    status: str(row, "status"),
    relatedBaseItemId: str(row, "relatedBaseItemId"),
    hasPendingQuestion: context.pendingQuestions.length > 0,
    deletedAt: str(row, "deletedAt"),
  };
}

/**
 * 受信メッセージを入れる会話を決める(2026-09-03 追加指示 §19)。
 *
 * ── 識別子の強い順に見る ────────────────────────────────────
 *
 * チャネル側の会話ID → 顧客ID → (どちらも無い場合だけ)表示名＋文脈。
 * 表示名は単独では効かない。同姓同名の別人の会話へ問い合わせを混ぜると、
 * 前の顧客の商品・価格・住所がそのまま新しい顧客への返信に出る。
 *
 * ── なぜ全件を集めてから判定するのか ────────────────────────
 *
 * 表示名照合では「候補が1件に決まるか」を見る必要がある。2件以上あれば
 * 結合しない、という判断は、先頭1件で打ち切っていてはできない。
 * 顧客IDが取れる通常経路(公式LINE)では**これまでどおり**顧客IDだけで
 * 絞るので、走査量は変わらない。
 */
async function findConversation(
  deps: WebhookStoreDeps,
  params: IncomingWebhookMessage,
): Promise<{ row: Record<string, unknown> | null; reason: string }> {
  const channel = params.channel;

  if (params.externalConversationId) {
    const rows = await scanConversations(
      deps,
      "channel = :c AND externalConversationId = :e",
      { ":c": channel, ":e": params.externalConversationId },
    );
    if (rows.length > 0) {
      const decision = decideConversationLink(
        {
          channel,
          externalCustomerId: params.externalCustomerId || null,
          externalConversationId: params.externalConversationId,
          customerDisplayName: params.customerDisplayName ?? null,
          receivedAt: params.externalSentAt,
          baseItemIds: params.baseItemIds ?? [],
        },
        rows.map(toCandidate),
      );
      const hit = rows.find((r) => String(r.id) === decision.conversationId) ?? null;
      if (hit) return { row: hit, reason: decision.reason };
    }
  }

  if (params.externalCustomerId) {
    const rows = await scanConversations(
      deps,
      "channel = :c AND externalCustomerId = :e",
      { ":c": channel, ":e": params.externalCustomerId },
    );
    if (rows.length > 0) {
      return { row: rows[0], reason: "チャネル側の顧客IDが一致しました。" };
    }
    return { row: null, reason: "この顧客IDの会話はまだありません。新しい会話にします。" };
  }

  // ── 顧客IDが取れない場合だけ、表示名を補助情報として使う ──
  const name = params.customerDisplayName?.trim();
  if (!name) return { row: null, reason: "顧客IDも表示名も無いため、新しい会話にします。" };

  const rows = await scanConversations(
    deps,
    "channel = :c AND customerDisplayName = :n",
    { ":c": channel, ":n": name },
  );
  const decision = decideConversationLink(
    {
      channel,
      externalCustomerId: null,
      externalConversationId: params.externalConversationId ?? null,
      customerDisplayName: name,
      receivedAt: params.externalSentAt,
      baseItemIds: params.baseItemIds ?? [],
    },
    rows.map(toCandidate),
  );
  const hit = decision.conversationId ? (rows.find((r) => String(r.id) === decision.conversationId) ?? null) : null;
  return { row: hit, reason: decision.reason };
}

/**
 * 取り込み済みかだけを調べる(保存はしない)。
 *
 * メール取り込みが「本文を取りに行く前に」既処理を弾くために使う。
 * 本文の取得は1通ごとにGmail APIを1往復するので、先に落とせるものを
 * 落としておかないと、2回目以降の実行でも毎回30通分の往復が発生する。
 */
export async function findMessageByExternalId(
  externalMessageId: string,
): Promise<{ conversationId?: string; messageId?: string } | null> {
  if (!CONVERSATION_TABLE || !MESSAGE_TABLE) {
    throw new Error("受信メッセージ保存用のテーブル名が未設定です（CONVERSATION_TABLE_NAME / MESSAGE_TABLE_NAME）。");
  }
  return findExistingMessage(
    {
      send: (command) => ddb().send(command as never) as Promise<Record<string, unknown>>,
      conversationTable: CONVERSATION_TABLE,
      messageTable: MESSAGE_TABLE,
      newId: randomUUID,
      now: () => new Date().toISOString(),
    },
    externalMessageId,
  );
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
  const already = await findExistingMessage(deps, params.externalMessageId);
  if (already) return { deduped: true, ...already };

  const now = deps.now();
  const preview = buildMessagePreview(params.body);
  const link = await findConversation(deps, params);
  const existing = link.row;
  // どう判断したかを残す。表示名で結合した/しなかったの根拠が追えないと、
  // 会話が分かれた・混ざったときに原因を特定できない。
  console.info("[webhookStore] 会話の紐付け", { channel: params.channel, linked: existing != null, reason: link.reason });

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
