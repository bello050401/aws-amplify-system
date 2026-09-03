import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { directTableName } from "@/lib/amplify/directData";

/**
 * 2026-09-04 追加指示 §51/§64: 「注文番号 → 商品」の対応の保存。
 *
 * ── なぜ DynamoDB を直接叩くのか ────────────────────────────────
 *
 * 取り込みは2つの経路から呼ばれる:
 *
 *   ・画面の「今すぐ取り込む」(Server Action、Cookieあり)
 *   ・scripts/ingest-mercari-mail.ts(定期実行、Cookie無し)
 *
 * 後者は AppSync(Cookie前提)では書けない。lib/messaging/webhookStore.ts と
 * lib/inquiry/contextStore.ts が同じ理由で直接アクセスしているので、
 * ここも合わせる —— 経路ごとに実装を分けると、片方だけ直す事故が起きる。
 *
 * ── 何度取り込んでも行が増えないこと(§70 ケースG) ────────────────
 *
 * 識別子は orderId そのもの。同じ購入通知を再取込しても Put で上書き
 * されるだけで、行は1つのまま。さらに**既にある値を空で潰さない**
 * (mergeOrderContext) —— 取引メッセージ由来の断片的な情報が、購入通知で
 * 確定した商品名を消してしまうのが一番まずい壊れ方。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";
const MODEL = "MercariOrderContext";

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/** 在庫の特定状態。ConversationContext の inventoryStatus と同じ語彙。 */
export type OrderInventoryStatus = "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND" | "NONE";

/** 何を根拠にこの対応を作ったか。§51 evidenceSource。 */
export type OrderContextEvidenceSource =
  /** 購入通知メール(§62 主経路)。 */
  | "PURCHASE_NOTIFICATION"
  /** 取引メッセージのメール本文。 */
  | "ORDER_MESSAGE"
  /** 保存済みデータに無く、Gmailを注文番号で検索して見つけたメール(§56)。 */
  | "GMAIL_SEARCH";

export interface MercariOrderContextRecord {
  orderId: string;
  inquiryIds: string[];
  productName: string | null;
  productPriceYen: number | null;
  quantity: number | null;
  itemAmountYen: number | null;
  shippingFeeYen: number | null;
  couponDiscountYen: number | null;
  totalAmountYen: number | null;
  requestedDeliveryDate: string | null;
  inventoryId: string | null;
  displayInventoryId: string | null;
  inventoryName: string | null;
  inventoryCandidateIds: string[];
  inventoryStatus: OrderInventoryStatus;
  baseItemId: string | null;
  baseUrl: string | null;
  resolvedAt: string | null;
  evidenceSource: OrderContextEvidenceSource | null;
  sourceGmailIds: string[];
  purchaseNotificationSeen: boolean;
  shopId: string | null;
  orderUrl: string | null;
  purchasedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/** 書き込む差分。**undefined は「今回は分からなかった」で既存値を消さない。** */
export type OrderContextPatch = Partial<
  Omit<MercariOrderContextRecord, "orderId" | "inquiryIds" | "sourceGmailIds" | "createdAt" | "updatedAt">
> & {
  /** 追加する問い合わせスレッドID(既存へ足す。置き換えない)。 */
  addInquiryIds?: string[];
  /** 追加するGmail message ID(既存へ足す)。 */
  addSourceGmailIds?: string[];
};

export interface OrderContextStoreDeps {
  send: (command: unknown) => Promise<Record<string, unknown>>;
  table: string;
  now: () => string;
}

function realDeps(): OrderContextStoreDeps | null {
  if (!process.env.CONVERSATION_TABLE_NAME) return null;
  return {
    send: (command) => ddb().send(command as never) as Promise<Record<string, unknown>>,
    table: directTableName(MODEL),
    now: () => new Date().toISOString(),
  };
}

function emptyRecord(orderId: string): MercariOrderContextRecord {
  return {
    orderId,
    inquiryIds: [],
    productName: null,
    productPriceYen: null,
    quantity: null,
    itemAmountYen: null,
    shippingFeeYen: null,
    couponDiscountYen: null,
    totalAmountYen: null,
    requestedDeliveryDate: null,
    inventoryId: null,
    displayInventoryId: null,
    inventoryName: null,
    inventoryCandidateIds: [],
    inventoryStatus: "NONE",
    baseItemId: null,
    baseUrl: null,
    resolvedAt: null,
    evidenceSource: null,
    sourceGmailIds: [],
    purchaseNotificationSeen: false,
    shopId: null,
    orderUrl: null,
    purchasedAt: null,
    createdAt: null,
    updatedAt: null,
    createdBy: null,
    updatedBy: null,
  };
}

function fromItem(item: Record<string, unknown>): MercariOrderContextRecord {
  const base = emptyRecord(String(item.orderId ?? ""));
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    ...base,
    inquiryIds: arr(item.inquiryIds),
    productName: str(item.productName),
    productPriceYen: num(item.productPriceYen),
    quantity: num(item.quantity),
    itemAmountYen: num(item.itemAmountYen),
    shippingFeeYen: num(item.shippingFeeYen),
    couponDiscountYen: num(item.couponDiscountYen),
    totalAmountYen: num(item.totalAmountYen),
    requestedDeliveryDate: str(item.requestedDeliveryDate),
    inventoryId: str(item.inventoryId),
    displayInventoryId: str(item.displayInventoryId),
    inventoryName: str(item.inventoryName),
    inventoryCandidateIds: arr(item.inventoryCandidateIds),
    inventoryStatus: (str(item.inventoryStatus) as OrderInventoryStatus | null) ?? "NONE",
    baseItemId: str(item.baseItemId),
    baseUrl: str(item.baseUrl),
    resolvedAt: str(item.resolvedAt),
    evidenceSource: (str(item.evidenceSource) as OrderContextEvidenceSource | null) ?? null,
    sourceGmailIds: arr(item.sourceGmailIds),
    purchaseNotificationSeen: item.purchaseNotificationSeen === true,
    shopId: str(item.shopId),
    orderUrl: str(item.orderUrl),
    purchasedAt: str(item.purchasedAt),
    createdAt: str(item.createdAt),
    updatedAt: str(item.updatedAt),
    createdBy: str(item.createdBy),
    updatedBy: str(item.updatedBy),
  };
}

/**
 * 既存の行へ差分を足す。**空で潰さない。**
 *
 * 純粋関数なので、実AWS無しで「購入通知で確定した商品名が、後続の
 * 取引メッセージで消えないこと」を機械的に確かめられる(§70 ケースG/H)。
 */
export function mergeOrderContext(
  prev: MercariOrderContextRecord,
  patch: OrderContextPatch,
): MercariOrderContextRecord {
  const keep = <T>(prevValue: T, next: T | null | undefined): T =>
    next === undefined || next === null ? prevValue : next;
  const uniq = (values: string[]): string[] => [...new Set(values.filter((v) => v && v.trim().length > 0))];

  return {
    ...prev,
    inquiryIds: uniq([...prev.inquiryIds, ...(patch.addInquiryIds ?? [])]),
    sourceGmailIds: uniq([...prev.sourceGmailIds, ...(patch.addSourceGmailIds ?? [])]),
    productName: keep(prev.productName, patch.productName),
    productPriceYen: keep(prev.productPriceYen, patch.productPriceYen),
    quantity: keep(prev.quantity, patch.quantity),
    itemAmountYen: keep(prev.itemAmountYen, patch.itemAmountYen),
    shippingFeeYen: keep(prev.shippingFeeYen, patch.shippingFeeYen),
    couponDiscountYen: keep(prev.couponDiscountYen, patch.couponDiscountYen),
    totalAmountYen: keep(prev.totalAmountYen, patch.totalAmountYen),
    requestedDeliveryDate: keep(prev.requestedDeliveryDate, patch.requestedDeliveryDate),
    // 在庫の特定は**後から良くなる**ことがある(§70 ケースH: 購入時点では
    // 在庫が見つからず、後日ZAICO同期や出品情報で解決できる)。
    // 一度 RESOLVED になったものを、後の未解決な結果で NONE へ戻さない。
    ...(patch.inventoryStatus === "RESOLVED" || prev.inventoryStatus !== "RESOLVED"
      ? {
          inventoryId: keep(prev.inventoryId, patch.inventoryId),
          displayInventoryId: keep(prev.displayInventoryId, patch.displayInventoryId),
          inventoryName: keep(prev.inventoryName, patch.inventoryName),
          inventoryCandidateIds:
            patch.inventoryCandidateIds && patch.inventoryCandidateIds.length > 0
              ? uniq(patch.inventoryCandidateIds)
              : prev.inventoryCandidateIds,
          inventoryStatus: keep(prev.inventoryStatus, patch.inventoryStatus),
          resolvedAt: keep(prev.resolvedAt, patch.resolvedAt),
        }
      : {}),
    baseItemId: keep(prev.baseItemId, patch.baseItemId),
    baseUrl: keep(prev.baseUrl, patch.baseUrl),
    // 出所は「より強い根拠」で上書きする。購入通知が最も強い(§65)。
    evidenceSource:
      patch.evidenceSource === "PURCHASE_NOTIFICATION" || prev.evidenceSource === null
        ? (patch.evidenceSource ?? prev.evidenceSource)
        : prev.evidenceSource,
    purchaseNotificationSeen: prev.purchaseNotificationSeen || patch.purchaseNotificationSeen === true,
    shopId: keep(prev.shopId, patch.shopId),
    orderUrl: keep(prev.orderUrl, patch.orderUrl),
    purchasedAt: keep(prev.purchasedAt, patch.purchasedAt),
    updatedBy: keep(prev.updatedBy, patch.updatedBy),
  };
}

/** 1件読む。**読めなくても例外にしない** —— 対応表が引けないことより、問い合わせを落とすほうが重い。 */
export async function getMercariOrderContext(orderId: string): Promise<MercariOrderContextRecord | null> {
  const deps = realDeps();
  if (!deps) return null;
  return getMercariOrderContextWith(deps, orderId);
}

export async function getMercariOrderContextWith(
  deps: OrderContextStoreDeps,
  orderId: string,
): Promise<MercariOrderContextRecord | null> {
  try {
    const res = await deps.send(new GetCommand({ TableName: deps.table, Key: { orderId } }));
    const item = (res as { Item?: Record<string, unknown> }).Item;
    return item ? fromItem(item) : null;
  } catch (err) {
    console.error("[mercariOrderContext] 読み込みに失敗", { orderId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * 差分を足して保存する。
 *
 * 版数による楽観ロックは置いていない。会話文脈(contextStore.ts)と違って、
 * この表は**同じ注文の情報を足していくだけ**で、片方の更新が消えても
 * 次のメールでまた足される。ロックのために読み書きを増やすほうが、
 * 取り込み1通あたりの時間として高くつく。
 */
export async function upsertMercariOrderContext(
  orderId: string,
  patch: OrderContextPatch,
): Promise<MercariOrderContextRecord | null> {
  const deps = realDeps();
  if (!deps) {
    console.error("[mercariOrderContext] CONVERSATION_TABLE_NAME が未設定のため保存できません。");
    return null;
  }
  return upsertMercariOrderContextWith(deps, orderId, patch);
}

export async function upsertMercariOrderContextWith(
  deps: OrderContextStoreDeps,
  orderId: string,
  patch: OrderContextPatch,
): Promise<MercariOrderContextRecord | null> {
  try {
    const prev = (await getMercariOrderContextWith(deps, orderId)) ?? emptyRecord(orderId);
    const now = deps.now();
    const merged = mergeOrderContext(prev, patch);
    const item: Record<string, unknown> = {
      ...merged,
      // AppSync経由で読めるように、直接書く行にも __typename を入れる
      // (lib/amplify/directData.ts の modelCreate と同じ理由)。
      __typename: MODEL,
      createdAt: prev.createdAt ?? now,
      updatedAt: now,
      createdBy: prev.createdBy ?? patch.updatedBy ?? null,
    };
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key];
    await deps.send(new PutCommand({ TableName: deps.table, Item: item }));
    return { ...merged, createdAt: item.createdAt as string, updatedAt: now };
  } catch (err) {
    console.error("[mercariOrderContext] 保存に失敗", { orderId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * 全件読む。
 *
 * 注文の件数は在庫(5,313件)と桁が違い、取り込み1回あたり1度だけ読む。
 * 取り込みの前に「この購入通知はもう処理したか」を判定するために使う
 * (購入通知は Message を作らないので、メッセージ側の重複判定に載らない)。
 */
export async function listAllMercariOrderContexts(): Promise<MercariOrderContextRecord[]> {
  const deps = realDeps();
  if (!deps) return [];
  return listAllMercariOrderContextsWith(deps);
}

export async function listAllMercariOrderContextsWith(
  deps: OrderContextStoreDeps,
): Promise<MercariOrderContextRecord[]> {
  const out: MercariOrderContextRecord[] = [];
  let key: Record<string, unknown> | undefined = undefined;
  let pages = 0;
  try {
    do {
      const res: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } =
        (await deps.send(new ScanCommand({ TableName: deps.table, ExclusiveStartKey: key }))) as never;
      for (const item of res.Items ?? []) out.push(fromItem(item));
      key = res.LastEvaluatedKey;
      pages++;
    } while (key && pages < 50);
  } catch (err) {
    // 読めなかったことを空配列に丸めない —— 呼び出し側は「まだ処理して
    // いない購入通知がある」と判断してもう一度取りに行くだけで、害は無い。
    console.error("[mercariOrderContext] 一覧の取得に失敗", err instanceof Error ? err.message : String(err));
  }
  return out;
}
