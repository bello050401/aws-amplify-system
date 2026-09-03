/**
 * 会話単位の確定情報(2026-09-03 追加指示 §17-§24)。
 *
 * ── なぜ要るのか ────────────────────────────────────────────────
 *
 * 実際に起きた事故:
 *
 *     顧客 「https://bellointeri.base.shop/items/156144635
 *            3万円まで下げられますか？」
 *     BELLO「お届け先の都道府県を教えていただけますでしょうか」
 *     顧客 「埼玉です」
 *
 * 3通目の「埼玉です」だけを見ると、商品も金額も交渉であることも分からない。
 * これを新規の問い合わせとして処理したため、返信案が
 * 「商品URLをお送りください」になった —— 顧客は既に送っている。
 *
 * 履歴の本文を毎回AIへ流し込むだけでは足りない。**確定した事実**
 * (どの商品か、いくらの希望か、何を尋ねて待っているか)は、文章から
 * 読み直すのではなく構造として保持する。読み直しは毎回同じ結果になる
 * 保証が無く、一度特定できた商品を次のターンで失う。
 *
 * ── このファイルの範囲 ──────────────────────────────────────────
 *
 * 純粋関数と型だけ。DBにも外部にも触らない(保存は contextStore.ts)。
 * 通知の組み立て(lib/messaging/lineNotify/format.ts)からも使うため
 * "server-only" を付けない。
 */
import type { InquiryIntent } from "./types";

/** 会話の中でこちらが尋ねて、まだ答えをもらえていない項目。 */
export type PendingQuestionField =
  | "DESTINATION_PREFECTURE"
  | "REQUESTED_DELIVERY_DATE"
  | "PRODUCT_URL"
  | "QUANTITY"
  | "BUDGET"
  | "OTHER";

export const PENDING_QUESTION_LABEL: Record<PendingQuestionField, string> = {
  DESTINATION_PREFECTURE: "お届け先の都道府県",
  REQUESTED_DELIVERY_DATE: "ご希望のお届け日",
  PRODUCT_URL: "商品URL",
  QUANTITY: "ご希望の数量",
  BUDGET: "ご予算",
  OTHER: "その他の確認事項",
};

export interface PendingQuestion {
  field: PendingQuestionField;
  /** いつ尋ねたか(ISO)。 */
  askedAt: string;
  /** どの文で尋ねたか。通知と診断に出す。 */
  askedText: string;
}

/**
 * 特定できた商品(§24)。
 *
 * **BASE商品と在庫を別々に持つ。** BASE URLから商品ページは確実に
 * 特定できているのに、対応するBELLO在庫が複数候補になることがある。
 * これを「商品を特定できませんでした」と一括りにすると、確実に分かって
 * いるBASE商品まで捨てることになる。
 */
export interface IdentifiedProductContext {
  baseItemId: string | null;
  baseItemUrl: string | null;
  /** BASE側の商品名。在庫が確定していなくても分かる。 */
  baseProductName: string | null;
  baseListedPriceYen: number | null;
  /** BASE商品として特定できているか。 */
  baseStatus: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND" | "NONE";
  inventoryId: string | null;
  displayInventoryId: string | null;
  /** 在庫名(確定したときのみ)。 */
  inventoryName: string | null;
  /** 在庫が絞り込めなかったときの候補。捨てずに残す(§24)。 */
  inventoryCandidateIds: string[];
  inventoryStatus: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND" | "NOT_REFERENCED" | "NONE";
  /** 何を根拠に特定したか(productIdentification.ts の IdentificationBasis)。 */
  basis: string | null;
  /** 現在販売価格(在庫が確定しているときのみ)。 */
  salePriceYen: number | null;
}

export interface NegotiationContextState {
  /** 交渉中か。返答済みでも「この会話は交渉だった」ことは残す。 */
  active: boolean;
  requestedTotalPriceYen: number | null;
  requestedUnitPriceYen: number | null;
  quantity: number | null;
  /** 交渉時点の販売価格。あとから値段を変えても当時の判断を追える。 */
  currentUnitPriceYen: number | null;
}

export interface ShippingContextState {
  prefecture: string | null;
  cityHint: string | null;
  estimatedShippingCostYen: number | null;
  rank: string | null;
}

export interface OrderContextState {
  orderId: string | null;
  /** ISO日付(YYYY-MM-DD)。 */
  requestedDeliveryDate: string | null;
}

/**
 * 会話の確定情報。**後続メッセージが短くても、ここまでに確定した情報が
 * 消えないこと**がこの型の存在理由(§20)。
 */
export interface ConversationContext {
  /** 楽観ロック用。保存のたびに +1(contextStore.ts)。 */
  version: number;
  updatedAt: string | null;
  channel: string | null;
  identifiedProduct: IdentifiedProductContext;
  negotiation: NegotiationContextState;
  shipping: ShippingContextState;
  order: OrderContextState;
  /** これまでに現れた問い合わせ種別(積み上げ)。 */
  intents: InquiryIntent[];
  /** いま顧客の答えを待っている項目。 */
  pendingQuestions: PendingQuestion[];
  /** 直近に適用した返信ルールID(診断用)。 */
  appliedReplyRuleIds: string[];
  /** 直近に参照したナレッジ文書ID(診断用)。 */
  knowledgeDocumentIds: string[];
  /** 社内で確認が必要な理由(§23: 内部都合の質問を顧客へ回さないための受け皿)。 */
  reviewReasons: string[];
}

export function emptyConversationContext(): ConversationContext {
  return {
    version: 0,
    updatedAt: null,
    channel: null,
    identifiedProduct: {
      baseItemId: null,
      baseItemUrl: null,
      baseProductName: null,
      baseListedPriceYen: null,
      baseStatus: "NONE",
      inventoryId: null,
      displayInventoryId: null,
      inventoryName: null,
      inventoryCandidateIds: [],
      inventoryStatus: "NONE",
      basis: null,
      salePriceYen: null,
    },
    negotiation: {
      active: false,
      requestedTotalPriceYen: null,
      requestedUnitPriceYen: null,
      quantity: null,
      currentUnitPriceYen: null,
    },
    shipping: { prefecture: null, cityHint: null, estimatedShippingCostYen: null, rank: null },
    order: { orderId: null, requestedDeliveryDate: null },
    intents: [],
    pendingQuestions: [],
    appliedReplyRuleIds: [],
    knowledgeDocumentIds: [],
    reviewReasons: [],
  };
}

/**
 * 会話文脈へ足す新しい情報。
 *
 * **undefined は「今回は分からなかった」で、既存値を消さない。**
 * null を明示的に渡した場合だけ消す(話題が変わったときの reset で使う)。
 * この区別が §21 の「新しい情報は既存Contextへマージする」の要。
 */
export interface ContextPatch {
  channel?: string | null;
  identifiedProduct?: Partial<IdentifiedProductContext>;
  negotiation?: Partial<NegotiationContextState>;
  shipping?: Partial<ShippingContextState>;
  order?: Partial<OrderContextState>;
  intents?: InquiryIntent[];
  appliedReplyRuleIds?: string[];
  knowledgeDocumentIds?: string[];
  reviewReasons?: string[];
}

/** undefined なら既存を保つ。null なら消す。値があれば置き換える。 */
function keep<T>(prev: T, next: T | undefined): T {
  return next === undefined ? prev : next;
}

function mergeSection<T extends object>(prev: T, patch: Partial<T> | undefined): T {
  if (!patch) return prev;
  const out = { ...prev };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = value as T[keyof T];
  }
  return out;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

/**
 * 既存の会話文脈へ新しい情報を足す(§21)。
 *
 * 消さないことを最優先にしている。「埼玉です」の1通で商品・希望価格・
 * 交渉であることが消えるのが今回の不具合そのものなので、**空の値で
 * 上書きしない**ことをこの関数の不変条件にする。
 */
export function mergeConversationContext(prev: ConversationContext, patch: ContextPatch): ConversationContext {
  return {
    ...prev,
    channel: keep(prev.channel, patch.channel),
    identifiedProduct: mergeSection(prev.identifiedProduct, patch.identifiedProduct),
    negotiation: mergeSection(prev.negotiation, patch.negotiation),
    shipping: mergeSection(prev.shipping, patch.shipping),
    order: mergeSection(prev.order, patch.order),
    intents: patch.intents ? [...new Set<InquiryIntent>([...prev.intents, ...patch.intents])] : prev.intents,
    appliedReplyRuleIds: patch.appliedReplyRuleIds ? uniq(patch.appliedReplyRuleIds) : prev.appliedReplyRuleIds,
    knowledgeDocumentIds: patch.knowledgeDocumentIds ? uniq(patch.knowledgeDocumentIds) : prev.knowledgeDocumentIds,
    reviewReasons: patch.reviewReasons ? uniq([...prev.reviewReasons, ...patch.reviewReasons]) : prev.reviewReasons,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 確認待ち(§22)
 * ══════════════════════════════════════════════════════════════════ */

/**
 * こちらが送った(送ろうとしている)文面から、何を尋ねたのかを読み取る。
 *
 * 返信案の文面そのものを見る。「何を確認中か」を別のフラグで持つと、
 * 文面と食い違ったときに直しようがない —— 実際に顧客が読むのは文面の方。
 */
const QUESTION_PATTERNS: { field: PendingQuestionField; re: RegExp }[] = [
  { field: "DESTINATION_PREFECTURE", re: /(?:お届け先|配送先|発送先|送り先).{0,12}(?:都道府県|地域|どちら|エリア)/ },
  { field: "DESTINATION_PREFECTURE", re: /都道府県.{0,20}(?:教え|お伺い|お聞かせ|いただけ|ご記入)/ },
  { field: "REQUESTED_DELIVERY_DATE", re: /(?:ご希望|希望).{0,8}(?:お届け日|配達日|配送日|納品日|日程)/ },
  { field: "REQUESTED_DELIVERY_DATE", re: /(?:お届け日|配達日).{0,20}(?:ご希望|教え|お伺い|いただけ)/ },
  { field: "PRODUCT_URL", re: /商品.{0,6}URL.{0,20}(?:お送り|教え|いただけ)/ },
  { field: "QUANTITY", re: /(?:ご希望|希望).{0,6}(?:数量|個数|点数)/ },
  { field: "BUDGET", re: /(?:ご予算|予算).{0,20}(?:教え|お伺い|いただけ)/ },
];

export function detectAskedQuestions(replyText: string | null | undefined, askedAt: string): PendingQuestion[] {
  if (!replyText) return [];
  const found: PendingQuestion[] = [];
  for (const p of QUESTION_PATTERNS) {
    if (found.some((f) => f.field === p.field)) continue;
    const m = p.re.exec(replyText);
    if (m) found.push({ field: p.field, askedAt, askedText: sentenceAround(replyText, m.index) });
  }
  return found;
}

/** 一致箇所を含む1文を切り出す。通知に出すので長すぎないようにする。 */
function sentenceAround(text: string, index: number): string {
  const starts = [text.lastIndexOf("\n", index), text.lastIndexOf("。", index)].filter((i) => i >= 0);
  const start = starts.length > 0 ? Math.max(...starts) + 1 : 0;
  const ends = [text.indexOf("。", index), text.indexOf("\n", index)].filter((i) => i >= 0);
  const end = ends.length > 0 ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim().slice(0, 120);
}

/** いま待っている項目か。 */
export function isPending(context: ConversationContext, field: PendingQuestionField): boolean {
  return context.pendingQuestions.some((q) => q.field === field);
}

/** 解消した項目を落とす。 */
export function clearPendingQuestions(
  context: ConversationContext,
  fields: PendingQuestionField[],
): ConversationContext {
  if (fields.length === 0) return context;
  return { ...context, pendingQuestions: context.pendingQuestions.filter((q) => !fields.includes(q.field)) };
}

/** 新しく尋ねた項目を積む(同じ項目は最新の1件だけ持つ)。 */
export function addPendingQuestions(
  context: ConversationContext,
  questions: PendingQuestion[],
): ConversationContext {
  if (questions.length === 0) return context;
  const kept = context.pendingQuestions.filter((q) => !questions.some((n) => n.field === q.field));
  return { ...context, pendingQuestions: [...kept, ...questions] };
}

/* ══════════════════════════════════════════════════════════════════
 * 話題の切り替わり
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 今回のメッセージが**別の商品**の話を始めたか。
 *
 * 引き継ぎを無条件にすると、話題が変わった会話で古い商品を引きずる
 * (2026-09-02 指示書§16が名指しで禁じた回帰)。顧客が別のBASE商品URLを
 * 送ってきた場合だけ、商品の引き継ぎを止める。
 *
 * **URLが無い短い返答では切り替えない。** 「埼玉です」で商品を捨てるのが
 * 今回直している不具合そのもの。
 */
export function switchesProduct(context: ConversationContext, currentBaseItemIds: string[]): boolean {
  const known = context.identifiedProduct.baseItemId;
  if (!known) return false;
  if (currentBaseItemIds.length === 0) return false;
  return !currentBaseItemIds.includes(known);
}

/* ══════════════════════════════════════════════════════════════════
 * 既知情報(§23 再質問の禁止)
 * ══════════════════════════════════════════════════════════════════ */

/**
 * すでに分かっていて、顧客へ聞き直してはいけない項目。
 *
 * 通知と、プロンプトの「これはもう尋ねない」指示の両方で使う。
 */
export function knownFacts(context: ConversationContext): { label: string; value: string }[] {
  const p = context.identifiedProduct;
  const out: { label: string; value: string }[] = [];
  const name = p.inventoryName ?? p.baseProductName;
  if (name) out.push({ label: "対象商品", value: name });
  if (p.baseItemUrl) out.push({ label: "商品URL", value: p.baseItemUrl });
  else if (p.baseItemId) out.push({ label: "BASE商品ID", value: p.baseItemId });
  const price = p.salePriceYen ?? p.baseListedPriceYen;
  if (price != null) out.push({ label: "販売価格", value: `${price.toLocaleString("ja-JP")}円` });
  if (context.negotiation.requestedTotalPriceYen != null) {
    out.push({ label: "希望価格", value: `${context.negotiation.requestedTotalPriceYen.toLocaleString("ja-JP")}円` });
  }
  if (context.negotiation.quantity != null) out.push({ label: "数量", value: `${context.negotiation.quantity}点` });
  if (context.shipping.prefecture) out.push({ label: "配送先", value: context.shipping.prefecture });
  if (context.shipping.estimatedShippingCostYen != null) {
    out.push({ label: "想定送料", value: `${context.shipping.estimatedShippingCostYen.toLocaleString("ja-JP")}円` });
  }
  if (context.order.orderId) out.push({ label: "注文番号", value: context.order.orderId });
  if (context.order.requestedDeliveryDate) out.push({ label: "希望配送日", value: context.order.requestedDeliveryDate });
  return out;
}

/** 会話が2ターン目以降で、引き継いだ情報があるか。 */
export function hasCarriedContext(context: ConversationContext): boolean {
  return knownFacts(context).length > 0;
}

/* ══════════════════════════════════════════════════════════════════
 * 保存形式
 * ══════════════════════════════════════════════════════════════════ */

/**
 * JSONから復元する。**壊れていても例外にしない。**
 *
 * 文脈が読めないことは、返信を1件も作れないことよりずっと軽い。
 * 読めなければ空の文脈として続行し、そのことを reviewReasons に残す。
 */
export function parseConversationContext(raw: string | null | undefined): ConversationContext {
  if (!raw) return emptyConversationContext();
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationContext>;
    const base = emptyConversationContext();
    return {
      ...base,
      ...parsed,
      version: typeof parsed.version === "number" ? parsed.version : 0,
      identifiedProduct: { ...base.identifiedProduct, ...(parsed.identifiedProduct ?? {}) },
      negotiation: { ...base.negotiation, ...(parsed.negotiation ?? {}) },
      shipping: { ...base.shipping, ...(parsed.shipping ?? {}) },
      order: { ...base.order, ...(parsed.order ?? {}) },
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      pendingQuestions: Array.isArray(parsed.pendingQuestions) ? parsed.pendingQuestions : [],
      appliedReplyRuleIds: Array.isArray(parsed.appliedReplyRuleIds) ? parsed.appliedReplyRuleIds : [],
      knowledgeDocumentIds: Array.isArray(parsed.knowledgeDocumentIds) ? parsed.knowledgeDocumentIds : [],
      reviewReasons: Array.isArray(parsed.reviewReasons) ? parsed.reviewReasons : [],
    };
  } catch {
    const empty = emptyConversationContext();
    return { ...empty, reviewReasons: ["会話の引き継ぎ情報を読み取れませんでした(保存形式が壊れています)。"] };
  }
}

export function serializeConversationContext(context: ConversationContext): string {
  return JSON.stringify(context);
}
