import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  emptyConversationContext,
  parseConversationContext,
  serializeConversationContext,
  type ConversationContext,
} from "./conversationContext";

/**
 * 会話文脈の保存(2026-09-03 追加指示 §20/§25)。
 *
 * ── どこに置くか ────────────────────────────────────────────────
 *
 * Conversation の行そのもの(inquiryContext / inquiryContextVersion)。
 * 会話と1対1で、会話が消えれば無意味になる情報なので別テーブルにしない。
 * Webhookの中で同期処理している現構成では、読み書きの往復がそのまま
 * 顧客への返信遅れになる、という実務上の理由もある。
 *
 * ── なぜ DynamoDB を直接叩くのか ────────────────────────────────
 *
 * 2つ理由がある。
 *
 *   1. LINE Webhook は未認証POSTで、AppSync(Cookie前提)では書けない。
 *      lib/messaging/webhookStore.ts が同じ理由で直接アクセスしている。
 *   2. **条件付き更新が要る。** Amplify Data のクライアントには
 *      「読んだ版と一致するときだけ書く」という口が無い。
 *
 * ── lost update をどう防ぐか(§25) ───────────────────────────────
 *
 * 「埼玉です」「できれば今週欲しいです」が連続で届くと、2つの処理が
 * 同じ版を読み、それぞれ別の項目を足して書き戻す。素直に書くと後勝ちで
 * 片方が消える —— 配送先だけが残り、希望日が消える、という壊れ方をする。
 *
 * 版数を条件にして書き、外れたら**読み直して同じマージをやり直す**。
 * マージ関数(mergeConversationContext)は「既存を消さない」ことを不変条件に
 * しているので、やり直しても両方の更新が残る。
 *
 * ── SQS を入れる場合(§25) ───────────────────────────────────────
 *
 * この仕組みは worker が並列でも壊れないが、**順序までは守れない**。
 * 「埼玉です」より先に「できれば今週欲しいです」が処理されると、返信案が
 * 参照する文脈が実際の会話の流れとずれる。SQS Standard は順序を保証しない
 * ので、同一会話を直列化する必要がある。実装するときは
 * MessageGroupId = conversationId の FIFO キューを使う ——
 * conversationId 単位で直列、会話をまたぐと並列、という必要な性質が
 * そのまま得られる。docs/conversation-context-20260903.md に判断の経緯を残す。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE_NAME;

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/** 版が競合したときのやり直し回数。3回外れるのは実質あり得ない(1会話への同時到着)。 */
export const CONTEXT_SAVE_MAX_ATTEMPTS = 5;

/**
 * この処理が外界に対して持つ依存の全て。
 *
 * lib/messaging/webhookStore.ts と同じ継ぎ目を置く。**同時到着で片方の
 * 更新が消えないこと**は、この機能の正しさの中心にありながら、実AWSでは
 * 狙って再現できない(2つの処理を同じ瞬間に走らせる必要がある)。
 * 偽の send を渡せば、条件付き更新が外れたときに読み直してやり直す、
 * という分岐そのものを機械的に確かめられる。
 */
export interface ContextStoreDeps {
  send: (command: unknown) => Promise<Record<string, unknown>>;
  conversationTable: string;
  now: () => string;
}

function realDeps(): ContextStoreDeps | null {
  if (!CONVERSATION_TABLE) return null;
  return {
    send: (command) => ddb().send(command as never) as Promise<Record<string, unknown>>,
    conversationTable: CONVERSATION_TABLE,
    now: () => new Date().toISOString(),
  };
}

export interface LoadedContext {
  context: ConversationContext;
  /** 読み込めたか。false なら空の文脈で続行している(黙って成功にしない)。 */
  loaded: boolean;
  /** 読み込めなかった理由(管理画面と通知に出す)。 */
  reason: string | null;
}

/**
 * 会話文脈を読む。
 *
 * **読めなくても例外にしない。** 文脈が無いことは返信案の質を落とすが、
 * 例外にすると問い合わせが1件も処理されない。どちらが重いかは明らか。
 * 代わりに「読めなかった」ことを必ず返し、呼び出し側が社内確認の理由に
 * 積めるようにする(§19「成功したふりをしない」)。
 */
export async function loadConversationContext(conversationId: string): Promise<LoadedContext> {
  const deps = realDeps();
  if (!deps) {
    return {
      context: emptyConversationContext(),
      loaded: false,
      reason: "CONVERSATION_TABLE_NAME が未設定のため、会話の引き継ぎ情報を読めませんでした。",
    };
  }
  return loadConversationContextWith(deps, conversationId);
}

/** 上の本体。依存を引数で受け取るので、テストから実AWS無しで通せる。 */
export async function loadConversationContextWith(
  deps: ContextStoreDeps,
  conversationId: string,
): Promise<LoadedContext> {
  try {
    const res = await deps.send(
      new GetCommand({
        TableName: deps.conversationTable,
        Key: { id: conversationId },
        ProjectionExpression: "inquiryContext, inquiryContextVersion",
      }),
    );
    const item = (res as { Item?: Record<string, unknown> }).Item as
      | { inquiryContext?: string | null; inquiryContextVersion?: number | null }
      | undefined;
    if (!item) {
      return { context: emptyConversationContext(), loaded: true, reason: null };
    }
    const context = parseConversationContext(item.inquiryContext ?? null);
    // 版数は行の値を正本にする。JSON側の version がずれていても、
    // 条件付き更新が見るのは行の属性なので、そちらへ合わせる。
    context.version = typeof item.inquiryContextVersion === "number" ? item.inquiryContextVersion : context.version;
    return { context, loaded: true, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[contextStore] 会話文脈を読めませんでした", { conversationId, message });
    return {
      context: emptyConversationContext(),
      loaded: false,
      reason: `会話の引き継ぎ情報を読めませんでした: ${message}`,
    };
  }
}

export interface SaveResult {
  saved: boolean;
  /** 保存できた場合の新しい版数。 */
  version: number | null;
  /** 版の競合でやり直した回数。 */
  retries: number;
  reason: string | null;
}

/**
 * 会話文脈を保存する。**読んだ版と一致するときだけ書く。**
 *
 * @param mutate 読み込んだ文脈から、保存したい文脈を作る関数。
 *   競合でやり直すときは**読み直した文脈で再実行される**ので、
 *   「前の値へ足す」形で書くこと(既存値を捨てる形で書くと、やり直しで
 *   相手の更新を消す)。
 */
export async function saveConversationContext(
  conversationId: string,
  mutate: (current: ConversationContext) => ConversationContext,
): Promise<SaveResult> {
  const deps = realDeps();
  if (!deps) {
    return {
      saved: false,
      version: null,
      retries: 0,
      reason: "CONVERSATION_TABLE_NAME が未設定のため、会話の引き継ぎ情報を保存できませんでした。",
    };
  }
  return saveConversationContextWith(deps, conversationId, mutate);
}

/** 上の本体。依存を引数で受け取るので、テストから実AWS無しで通せる。 */
export async function saveConversationContextWith(
  deps: ContextStoreDeps,
  conversationId: string,
  mutate: (current: ConversationContext) => ConversationContext,
): Promise<SaveResult> {

  let retries = 0;
  let current: ConversationContext | null = null;

  for (let attempt = 1; attempt <= CONTEXT_SAVE_MAX_ATTEMPTS; attempt++) {
    if (current === null) current = (await loadConversationContextWith(deps, conversationId)).context;

    const expected = current.version;
    const next = mutate(current);
    const version = expected + 1;
    const payload: ConversationContext = { ...next, version, updatedAt: deps.now() };

    try {
      await deps.send(
        new UpdateCommand({
          TableName: deps.conversationTable,
          Key: { id: conversationId },
          UpdateExpression: "SET inquiryContext = :c, inquiryContextVersion = :v, updatedAt = :t",
          // 版が一致するときだけ書く。初回(属性がまだ無い)も通す。
          ConditionExpression: "attribute_not_exists(inquiryContextVersion) OR inquiryContextVersion = :e",
          ExpressionAttributeValues: {
            ":c": serializeConversationContext(payload),
            ":v": version,
            ":e": expected,
            ":t": payload.updatedAt,
          },
        }),
      );
      return { saved: true, version, retries, reason: null };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "ConditionalCheckFailedException" && attempt < CONTEXT_SAVE_MAX_ATTEMPTS) {
        // 別の処理が先に書いた。読み直して同じ変更をやり直す。
        retries++;
        current = null;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[contextStore] 会話文脈を保存できませんでした", { conversationId, message, attempt });
      return { saved: false, version: null, retries, reason: `会話の引き継ぎ情報を保存できませんでした: ${message}` };
    }
  }

  return {
    saved: false,
    version: null,
    retries,
    reason: `会話の引き継ぎ情報が${CONTEXT_SAVE_MAX_ATTEMPTS}回続けて競合したため保存できませんでした。`,
  };
}
