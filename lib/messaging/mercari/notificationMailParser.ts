/**
 * 2026-09-03 追加指示 §1/§2/§3: メルカリShops問い合わせ通知メールの解析。
 *
 * ── 実メールを基準に書き直した ──────────────────────────────────
 *
 * 以前の実装は「ラベル + 値」「区切り線」という一般的な通知メール像を仮定して
 * 書いており、**実物と合っていなかった**。その結果、件名と商品名は取れるのに
 * 顧客本文が取れず、件名だけを材料にAIが「素材」と誤分類していた。
 *
 * 実物(Staging接続済みのGmailから取得)の形は次のとおり。
 *
 *   メルカリShopsをご利用いただきありがとうございます。
 *   商品に関して、お客さまからの問い合わせを受け付けました。      ← 種別
 *
 *   ▼お客さまからのメッセージ
 *   領収書は商品に同封頂けそうでしょうか？                        ← 顧客本文
 *
 *   以下のURLより、内容をご確認ください。                          ← 本文の終端
 *
 *   ▼問い合わせページ
 *   https://mercari-shops.com/seller/shops/<shopId>/inquiries/<inquiryId>?source=deeplink
 *
 *   ▼商品情報
 *   商品名 : ...
 *   商品価格 : ¥24,800      (取引メッセージのみ)
 *   数量 : 1                (取引メッセージのみ)
 *
 *   ▼注文情報                                                     (取引メッセージのみ)
 *   注文番号 : order_xxx
 *   商品代金 : ¥24,800
 *   送料 : ¥0
 *   クーポン割引 : -¥0
 *   合計金額 : ¥24,800
 *
 * ── 2種類を本文で見分ける(件名では見ない) ──────────────────────
 *
 * §2。件名はどちらも「〜への追加の問い合わせを受け付けました」で紛らわしく、
 * 表現もサービス側の都合で変わる。本文の定型文を主判定材料にする。
 *
 *   「お取引中の注文に関して、お客さまからの問い合わせを受け付けました。」→ ORDER_MESSAGE
 *   「商品に関して、お客さまからの問い合わせを受け付けました。」          → PRODUCT_INQUIRY
 *
 * ── 取れなかったものは推測しない ────────────────────────────────
 *
 * §1末尾・§3。本文が取れなければ PARSE_FAILED にして、**件名や商品名から
 * 問い合わせ意図を推測させない**。実際にそれで誤分類が出ている。
 */

export type MercariMailKind =
  /** 商品に関する通常の問い合わせ。 */
  | "PRODUCT_INQUIRY"
  /** 購入済み注文に対する取引メッセージ。 */
  | "ORDER_MESSAGE"
  /**
   * 購入通知(「〜の発送をお願いします。」)。**問い合わせではない**。
   *
   * 2026-09-04 追加指示 §62/§69。購入が発生した時点で届き、
   * **商品名と注文番号が必ず揃っている**。取引メッセージ側は後続で
   * 商品名が落ちることがあるので、ここで作った「注文番号 → 商品」の
   * 対応が商品復元の主経路になる(§65)。
   *
   * 返信対象ではないので、会話もAI返信も社内通知も作らない(§63)。
   */
  | "PURCHASE_NOTIFICATION";

export type MercariMailParseStatus =
  /** 顧客本文まで取れた。 */
  | "PARSED"
  /** 問い合わせ通知だが本文を取り出せなかった(§3 分類させない)。 */
  | "PARSE_FAILED"
  /**
   * 購入通知として解析できた(2026-09-04 追加指示 §62/§63)。
   *
   * **NOT_INQUIRY と分けるのが肝。** 一緒にすると「取り込まない」の一言で
   * 捨てられ、購入時点でしか手に入らない「注文番号 → 商品名」を毎回
   * 取り逃す。問い合わせとしては扱わないが、注文の対応表は必ず作る。
   */
  | "PURCHASE_NOTIFICATION"
  /** 問い合わせ通知メールではない。取り込まない。 */
  | "NOT_INQUIRY";

export interface MercariMailInput {
  subject: string;
  text: string;
  html: string;
  /** メールの Message-ID ヘッダ。 */
  messageId: string;
  receivedAt: string;
  from: string;
}

/** §1 注文情報。取引メッセージと購入通知に存在する。 */
export interface MercariOrderInfo {
  orderNumber: string | null;
  /** 円。取れなければ null(0と区別する)。 */
  itemAmountYen: number | null;
  shippingFeeYen: number | null;
  couponDiscountYen: number | null;
  totalAmountYen: number | null;
}

export interface MercariMailParseResult {
  status: MercariMailParseStatus;
  /** 通常問い合わせか取引メッセージか。判定できなければ null。 */
  kind: MercariMailKind | null;
  /** 顧客が書いた本文。取れなければ null。**推測で埋めない。** */
  messageText: string | null;
  productName: string | null;
  productPriceYen: number | null;
  quantity: number | null;
  /** 問い合わせページURL。 */
  inquiryUrl: string | null;
  /** 問い合わせID。同じ問い合わせを1つの会話へまとめる鍵(§5)。 */
  inquiryId: string | null;
  shopId: string | null;
  /**
   * 注文ページURL。購入通知にだけ入る。
   *
   * §53 inquiryId(会話の識別)と orderId(注文の識別)は役割が違う。
   * 購入通知には問い合わせページが無く、注文ページしか無い。
   */
  orderUrl: string | null;
  order: MercariOrderInfo;
  /** 何を手がかりに取れたか。解析の当たり外れを後から追える。 */
  notes: string[];
}

/** 顧客本文の開始・終了マーカー。実メールで確認した文字列。 */
const BODY_START = "▼お客さまからのメッセージ";
const BODY_END = "以下のURLより、内容をご確認ください。";

/** §2 種別の判定に使う定型文。 */
const ORDER_MARKER = "お取引中の注文に関して、お客さまからの問い合わせを受け付けました";
const PRODUCT_MARKER = "商品に関して、お客さまからの問い合わせを受け付けました";

/**
 * §62 購入通知の定型文(実メールで確認、2026-09-04)。
 *
 *   下記の商品をHappyさんが購入しました。商品の発送をお願いします。
 *
 * 件名にも「〜の発送をお願いします。」が入るが、**本文で判定する** ——
 * 件名の言い回しはサービス側の都合で変わる(§2と同じ理由)。
 * 購入者の呼び名が本文に入るので、その部分は判定に使わない。
 */
const PURCHASE_MARKER = "商品の発送をお願いします";
const PURCHASE_SECONDARY_MARKER = "が購入しました";

/** 問い合わせページURL。shopId と inquiryId を同時に取る。 */
const INQUIRY_URL_RE =
  /https?:\/\/mercari-shops\.com\/seller\/shops\/([A-Za-z0-9_-]+)\/inquiries\/([A-Za-z0-9_-]+)(?:\?[^\s"'<>]*)?/;

/**
 * 注文ページURL。購入通知の「▼配送先情報」に入る。
 *
 * URL側のIDは `order_` 接頭辞が付かない(実メール: 注文番号
 * `order_2JWDBkbJuYtXpRfLvaHaBF` に対し URL は `/orders/2JWDBkbJuYtXpRfLvaHaBF`)。
 * 注文番号の行が取れなかったときの**予備の経路**として使う。
 */
const ORDER_URL_RE =
  /https?:\/\/mercari-shops\.com\/seller\/shops\/([A-Za-z0-9_-]+)\/orders\/([A-Za-z0-9_-]+)(?:\?[^\s"'<>]*)?/;

/**
 * 注文番号の正規化。
 *
 * 注文番号の行(`order_xxx`)とURLのID(`xxx`)は**同じ注文の別表記**。
 * どちらから来ても同じ鍵になるようにしないと、同じ注文が2行に分かれ、
 * 「注文番号 → 商品」の対応が引けなくなる。
 */
export function canonicalOrderId(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return v.startsWith("order_") ? v : `order_${v}`;
}

/**
 * HTMLを素朴なテキストへ落とす。
 *
 * §1「HTMLとplain textの両方で同じ本文が取得できるように」。実メールの
 * HTML版は `<p>▼お客さまからのメッセージ<br>本文</p>` の形なので、
 * タグを改行へ落とせばマーカーもそのまま残り、text/plain と同じ抽出が効く。
 * **CSSセレクタに依存しない**(§14「fragileなセレクタだけに依存しない」)。
 */
export function htmlToText(html: string): string {
  return html
    // script/style はタグを剥がす前に中身ごと落とす。後からだと本文に混ざる。
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    // リンク先URLを残す。問い合わせページURLがhrefにしか無い場合に落とさない。
    .replace(/<\s*a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, (_m, href, label) => ` ${label} ${href} `)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    // 行頭・行末の空白だけを畳む。行の中の全角空白は本文の一部なので残す。
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 「ラベル : 値」を拾う。実メールは半角スペース + 半角コロンだが、
 * 全角コロンやスペース無しにも耐えるようにしておく。
 */
function labelled(text: string, label: string): string | null {
  const re = new RegExp(`^[\\s>]*${label}\\s*[:：]\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * 「¥24,800」「-¥0」→ 数値。
 *
 * **取れなければ null。0にしない。** 送料0円と「送料の記載が無い」は別物で、
 * 0にまとめると「送料無料」と誤って案内しうる。
 */
function yenToNumber(raw: string | null): number | null {
  if (raw == null) return null;
  const m = raw.replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d))).match(/(-?)\s*[¥￥]?\s*([\d,]+)/);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return m[1] === "-" ? -n : n;
}

function emptyOrder(): MercariOrderInfo {
  return { orderNumber: null, itemAmountYen: null, shippingFeeYen: null, couponDiscountYen: null, totalAmountYen: null };
}

/**
 * 顧客本文の抽出。**マーカーで挟まれた範囲だけ**を採る。
 *
 * 範囲が取れなければ null を返す(推測しない)。以前は「区切り線に挟まれた
 * 最長の塊」という当て推量で拾おうとして、定型文を本文と誤認していた。
 */
function extractBody(text: string): string | null {
  const start = text.indexOf(BODY_START);
  if (start < 0) return null;
  const afterStart = start + BODY_START.length;
  const end = text.indexOf(BODY_END, afterStart);
  const raw = end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart);
  const body = raw.trim();
  return body.length > 0 ? body : null;
}

export function parseMercariNotificationMail(input: MercariMailInput): MercariMailParseResult {
  const notes: string[] = [];
  const plain = (input.text ?? "").trim();
  const fromHtml = input.html ? htmlToText(input.html) : "";

  // text/plain を主に使う。実メールでは plain が完全なので、まずそちらで
  // 試し、取れなければHTML版へ落ちる。両方を連結しない —— 連結すると本文が
  // 2回現れ、マーカーの範囲がずれる。
  const candidates = [plain, fromHtml].filter((t) => t.length > 0);
  if (candidates.length === 0) {
    notes.push("本文が空のメール");
    return notInquiry(notes);
  }

  // 種別の定型文を含む方を採用する。
  const source =
    candidates.find(
      (t) => t.includes(ORDER_MARKER) || t.includes(PRODUCT_MARKER) || t.includes(PURCHASE_MARKER),
    ) ?? candidates[0];

  // ── §2/§69 種別(本文の定型文で判定。件名は見ない) ─────────────
  //
  // **問い合わせの定型文を先に見る。** 購入通知の定型文は「発送をお願い
  // します」という一般的な言い回しなので、将来ほかのシステムメールにも
  // 現れうる。問い合わせ判定を先に通し、購入通知は最後に置くことで、
  // 取り違えたときに「返信を作る側」へ倒れないようにする(§69 安全側)。
  const kind: MercariMailKind | null = source.includes(ORDER_MARKER)
    ? "ORDER_MESSAGE"
    : source.includes(PRODUCT_MARKER)
      ? "PRODUCT_INQUIRY"
      : source.includes(PURCHASE_MARKER) && source.includes(PURCHASE_SECONDARY_MARKER)
        ? "PURCHASE_NOTIFICATION"
        : null;

  if (kind === null) {
    // メルカリShopsからのメールでも、問い合わせ通知でも購入通知でもない
    // もの(売上速報・キャンペーン・入荷リクエスト等)は取り込まない。
    notes.push("問い合わせ通知・購入通知の定型文が無い");
    return notInquiry(notes);
  }
  notes.push(
    kind === "ORDER_MESSAGE"
      ? "本文の定型文から取引メッセージと判定"
      : kind === "PRODUCT_INQUIRY"
        ? "本文の定型文から商品問い合わせと判定"
        : "本文の定型文から購入通知と判定(§63 返信対象ではない)",
  );

  // ── 問い合わせページ / 注文ページ ────────────────────────
  const urlMatch = source.match(INQUIRY_URL_RE);
  const inquiryUrl = urlMatch ? urlMatch[0] : null;
  const inquiryId = urlMatch ? urlMatch[2] : null;
  if (inquiryId) notes.push("問い合わせIDを取得");

  const orderUrlMatch = source.match(ORDER_URL_RE);
  const orderUrl = orderUrlMatch ? orderUrlMatch[0] : null;
  // §53 shopId はどちらのURLからでも取れる。会話の識別には使わない。
  const shopId = urlMatch ? urlMatch[1] : (orderUrlMatch?.[1] ?? null);

  // ── 商品・注文情報 ───────────────────────────────────────
  const productName = labelled(source, "商品名");
  const productPriceYen = yenToNumber(labelled(source, "商品価格"));
  const quantityRaw = labelled(source, "数量");
  const quantity = quantityRaw ? (Number.isFinite(Number(quantityRaw)) ? Number(quantityRaw) : null) : null;

  const order: MercariOrderInfo = {
    // 注文番号の行が第一。取れなければ注文ページURLのIDから組み立てる ——
    // どちらから来ても同じ鍵になるよう canonicalOrderId を通す(§53)。
    orderNumber:
      canonicalOrderId(labelled(source, "注文番号")) ?? canonicalOrderId(orderUrlMatch?.[2] ?? null),
    itemAmountYen: yenToNumber(labelled(source, "商品代金")),
    shippingFeeYen: yenToNumber(labelled(source, "送料")),
    couponDiscountYen: yenToNumber(labelled(source, "クーポン割引")),
    totalAmountYen: yenToNumber(labelled(source, "合計金額")),
  };
  if (order.orderNumber) notes.push("注文番号を取得");

  // ── §63 購入通知はここで終わり ───────────────────────────
  //
  // 顧客本文は無い(そもそも顧客は何も書いていない)。本文が無いことを
  // 「解析失敗」にすると、社内へ【要確認】が飛ぶ —— 購入通知は
  // 確認すべきことが何も無いメールなので、それは雑音でしかない。
  if (kind === "PURCHASE_NOTIFICATION") {
    if (!productName) notes.push("購入通知だが商品名を取り出せなかった");
    return {
      status: "PURCHASE_NOTIFICATION",
      kind,
      messageText: null,
      productName,
      productPriceYen,
      quantity,
      inquiryUrl,
      inquiryId,
      shopId,
      orderUrl,
      order,
      notes,
    };
  }

  // ── 顧客本文 ─────────────────────────────────────────────
  const messageText = extractBody(source);
  if (!messageText) {
    // §3 本文が取れないまま分類・返信案生成へ進ませない。
    notes.push("顧客本文のマーカーを見つけられなかった");
    return {
      status: "PARSE_FAILED",
      kind,
      messageText: null,
      productName,
      productPriceYen,
      quantity,
      inquiryUrl,
      inquiryId,
      shopId,
      orderUrl,
      order,
      notes,
    };
  }
  notes.push("顧客本文を抽出");

  return { status: "PARSED", kind, messageText, productName, productPriceYen, quantity, inquiryUrl, inquiryId, shopId, orderUrl, order, notes };
}

/** 取り込み対象外。項目を1箇所で埋め、足し忘れを防ぐ。 */
function notInquiry(notes: string[]): MercariMailParseResult {
  return {
    status: "NOT_INQUIRY",
    kind: null,
    messageText: null,
    productName: null,
    productPriceYen: null,
    quantity: null,
    inquiryUrl: null,
    inquiryId: null,
    shopId: null,
    orderUrl: null,
    order: emptyOrder(),
    notes,
  };
}

/**
 * 商品特定に使うテキスト。
 *
 * §4「内部の商品特定失敗を顧客へ転嫁しない」。メールには**商品URLが無く、
 * 商品名しか入っていない**(実メールで確認)。既存の productResolver は
 * 商品名の断片からも照合できるので、商品名を渡して最大限当てにいく。
 *
 * 顧客本文は混ぜない —— 本文に商品名と無関係な語(日付・宛名等)が入ると、
 * 全件スキャンの名前照合でノイズになる。
 */
export function buildProductLookupText(result: MercariMailParseResult): string {
  return [result.productName].filter(Boolean).join("\n");
}

/**
 * 会話をまとめる鍵(§5)。
 *
 * **同じ問い合わせページ → 同じConversation。** 実メールで、同一の
 * inquiryId を持つメールが複数届くことを確認済み(追加の問い合わせ)。
 * 問い合わせIDが取れなければメール単位に分ける —— 取れないものを
 * まとめると、無関係な問い合わせが1つの会話に混ざる。
 */
export function conversationKeyFor(result: MercariMailParseResult, fallbackMessageId: string): string {
  if (result.inquiryId) return `mercari-inquiry:${result.inquiryId}`;
  return `mercari-mail:${fallbackMessageId}`;
}
