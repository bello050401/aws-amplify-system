/**
 * 2026-09-03 指示書 §13/§14/§15: メルカリShopsの問い合わせ通知メールの解析。
 *
 * ── 前提: BELLOはメルカリShops APIを直接使えない ────────────────
 *
 * §13。問い合わせの受信経路は「メルカリShopsから届く通知メール」しかない。
 * (既存の lib/messaging/mercari/inquiryAdapter.ts に、API経由での受信が
 *  BLOCKED_BY_EXTERNAL_SERVICE である調査記録が残っている。)
 *
 * ── **重要: このパーサは実物のメールで検証できていない** ─────────
 *
 * §14 は「実際の通知メールのサンプルを取得できる場合、必ず実物を基準に
 * parserを作る」としている。現時点でサンプルが手元に無いため、ここは
 * 一般的な通知メールの構造(ラベル + 値、商品URL、区切り線)に対する
 * **複数の手がかりの組み合わせ**として書いてある。
 *
 * だからこそ、**失敗しても捨てない**設計を最優先にした:
 *
 *   - 本文が取れなければ status = "PARSE_FAILED"。受信自体は保存する
 *   - 商品が特定できなければ product は null。推測で埋めない
 *   - 顧客名が取れなければ null。「お客様」等の名前を作らない
 *
 * サンプルが1通手に入ったら、PATTERNS を実物に合わせて足すだけで精度が
 * 上がる形にしてある(セレクタや固定の行番号に依存していない)。
 *
 * ── 純粋関数 ────────────────────────────────────────────────────
 *
 * ネットワークにもAWSにも触らない。§42 が parser unit test を要求して
 * いるので、scripts/verify-mercari-mail.ts で固定する。
 */

export type MercariMailParseStatus =
  /** 問い合わせとして必要な情報が取れた。 */
  | "PARSED"
  /** メール自体は問い合わせ通知だが、本文を取り出せなかった(§14 解析失敗)。 */
  | "PARSE_FAILED"
  /** そもそも問い合わせ通知メールではない。取り込まない。 */
  | "NOT_INQUIRY";

export interface MercariMailInput {
  subject: string;
  /** text/plain パート。無ければ空文字。 */
  text: string;
  /** text/html パート。無ければ空文字。 */
  html: string;
  /** メールの Message-ID ヘッダ。重複判定の第一キー(§10)。 */
  messageId: string;
  /** 受信日時(ISO)。 */
  receivedAt: string;
  from: string;
}

export interface MercariMailParseResult {
  status: MercariMailParseStatus;
  /** 問い合わせ本文。取れなければ null。 */
  messageText: string | null;
  /** 顧客名。取れなければ null(§7-2 作らない)。 */
  customerName: string | null;
  /** 商品名。取れなければ null。 */
  productName: string | null;
  /** 商品ページのURL。取れなければ null。 */
  productUrl: string | null;
  /** 商品ID(URLから取り出せた場合)。 */
  externalProductId: string | null;
  /** メルカリShops管理画面のURL(担当者が実際に返信しに行く先)。 */
  adminUrl: string | null;
  /** 何を手がかりに取れたか。解析の当たり外れを後から追えるようにする。 */
  notes: string[];
}

/**
 * 問い合わせ通知だと判断する手がかり。件名だけに頼らない ——
 * 件名の文言はサービス側の都合で変わる。
 */
const INQUIRY_SUBJECT_HINTS = ["お問い合わせ", "問い合わせ", "メッセージ", "inquiry"];

/** 送信元がメルカリらしいか。ドメインで見る。 */
const MERCARI_FROM_HINTS = ["mercari", "mercari-shops"];

/**
 * 商品URL。メルカリShopsの商品ページは
 *   https://mercari-shops.com/products/<id>
 * の形。ショップ独自ドメインの可能性もあるので、products/<id> の形も拾う。
 */
const PRODUCT_URL_PATTERNS: RegExp[] = [
  /https?:\/\/mercari-shops\.com\/products\/([A-Za-z0-9_-]+)/i,
  /https?:\/\/[^\s"'<>]*mercari[^\s"'<>]*\/products\/([A-Za-z0-9_-]+)/i,
  /https?:\/\/jp\.mercari\.com\/shops\/product\/([A-Za-z0-9_-]+)/i,
];

/** 管理画面URL。担当者はここから実際の返信を行う(§48 自動返信はしない)。 */
const ADMIN_URL_PATTERNS: RegExp[] = [
  /https?:\/\/mercari-shops\.com\/(?:admin|shops)\/[^\s"'<>]+/i,
  /https?:\/\/[^\s"'<>]*mercari[^\s"'<>]*\/(?:admin|dashboard)\/[^\s"'<>]+/i,
];

/**
 * ラベル付きの値。「商品名：〇〇」「お客様：〇〇」のような行を拾う。
 * 全角/半角のコロン、前後の空白のゆれを許容する。
 */
function labelledValue(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`^[\\s>]*${label}\\s*[:：]\\s*(.+)$`, "m");
    const m = text.match(re);
    if (m) {
      const value = m[1].trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * HTMLを素朴なテキストへ落とす。
 *
 * **CSSセレクタに依存しない**(§14「fragileなCSSセレクタだけに依存しない」)。
 * メールのHTML構造はサービス側の都合でいつでも変わるが、「ラベルと値が
 * 並んでいる」という性質は変わりにくい。だからタグを落として本文として
 * 扱い、ラベル一致で拾う。
 */
export function htmlToText(html: string): string {
  return html
    // scriptとstyleは**タグを剥がす前に**中身ごと落とす。後から落とすと、
    // 中のJS/CSSが本文として混ざり、ラベル抽出のノイズになる。
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    // リンク先URLを本文へ残す。
    //
    // タグを剥がすだけだと href が消える。通知メールでは商品URLが
    // **リンクの中にしか無い**ことが多く(「商品ページはこちら」のような
    // アンカーテキスト)、そこを落とすと商品特定の一番確実な手がかり
    // (§15 URL優先)を自ら捨てることになる。
    .replace(/<\s*a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, (_m, href, label) => ` ${label} ${href} `)
    // <br>/<p>/</div>/</tr> は改行として扱う。ここを潰すと
    // 「ラベル：値」が1行に連結して、行単位の抽出が効かなくなる。
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // 実体参照。&amp; を最後に置かないと、二重にデコードされた文字列が
    // 別の実体参照として解釈されうる。
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(text: string, patterns: RegExp[]): { url: string; id: string | null } | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { url: m[0], id: m[1] ?? null };
  }
  return null;
}

/**
 * 問い合わせ本文の抽出。
 *
 * 通知メールは「定型の案内 + 問い合わせ本文 + フッター」という構造を取る
 * ことが多い。本文だけを取り出すために、まずラベルで試し、駄目なら
 * 区切り線に挟まれた塊を探す。**どちらも駄目なら null**(推測しない)。
 */
function extractBody(text: string): { body: string | null; note: string } {
  const labelled = labelledValue(text, ["お問い合わせ内容", "メッセージ", "問い合わせ内容", "内容", "本文"]);
  if (labelled && labelled.length >= 2) return { body: labelled, note: "ラベル(お問い合わせ内容)から抽出" };

  // 区切り線(────, ====, ----, ■■■)で囲まれた最も長い塊。
  const blocks = text
    .split(/^[\s>]*[-=─━_*#■]{4,}[\s]*$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (blocks.length >= 2) {
    // 先頭は挨拶、末尾はフッターになりやすいので、中間で最長のものを採る。
    const middle = blocks.slice(1, Math.max(1, blocks.length - 1));
    const longest = middle.sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 4) return { body: longest, note: "区切り線に挟まれた本文として抽出" };
  }

  return { body: null, note: "本文を特定できなかった" };
}

export function parseMercariNotificationMail(input: MercariMailInput): MercariMailParseResult {
  const notes: string[] = [];
  // plain text を優先し、無ければ HTML から落とす。両方あれば連結して
  // 手がかりを増やす —— 商品URLがHTML側のリンクにしか無いことがある。
  const plain = input.text?.trim() ?? "";
  const fromHtml = input.html ? htmlToText(input.html) : "";
  const combined = [plain, fromHtml].filter(Boolean).join("\n\n");

  const empty: MercariMailParseResult = {
    status: "NOT_INQUIRY",
    messageText: null,
    customerName: null,
    productName: null,
    productUrl: null,
    externalProductId: null,
    adminUrl: null,
    notes,
  };

  if (!combined) {
    notes.push("本文が空のメール");
    return { ...empty, status: "NOT_INQUIRY" };
  }

  // ── 問い合わせ通知メールか ────────────────────────────────
  //
  // 件名と送信元の**両方**を見る。件名だけだと、転送メールや他サービスの
  // 「お問い合わせ」通知まで拾ってしまう。
  const subject = input.subject ?? "";
  const subjectLooksLikeInquiry = INQUIRY_SUBJECT_HINTS.some((h) => subject.toLowerCase().includes(h.toLowerCase()));
  const fromLooksLikeMercari = MERCARI_FROM_HINTS.some((h) => (input.from ?? "").toLowerCase().includes(h));
  const bodyMentionsMercari = /メルカリ|mercari/i.test(combined);

  if (!fromLooksLikeMercari && !bodyMentionsMercari) {
    notes.push("送信元にも本文にもメルカリの記載が無い");
    return { ...empty, status: "NOT_INQUIRY" };
  }
  if (!subjectLooksLikeInquiry && !/お問い合わせ|問い合わせ|メッセージ/.test(combined)) {
    notes.push("問い合わせ通知を示す語が無い");
    return { ...empty, status: "NOT_INQUIRY" };
  }

  // ── 商品 ──────────────────────────────────────────────────
  //
  // §15 の優先順位どおり、**まずURLから**。商品名の曖昧一致より確実。
  const product = firstMatch(combined, PRODUCT_URL_PATTERNS);
  if (product) notes.push("商品URLから商品IDを取得");
  const productName = labelledValue(combined, ["商品名", "商品", "対象商品", "アイテム"]);
  if (productName) notes.push("ラベル(商品名)から商品名を取得");

  const admin = firstMatch(combined, ADMIN_URL_PATTERNS);
  if (admin) notes.push("管理画面URLを取得");

  // ── 顧客名 ────────────────────────────────────────────────
  //
  // 取れなければ null のまま。「お客様」のような一般名詞を入れると、
  // 通知に「お名前：お客様」と出て、取得できたのか失敗したのか読めない。
  const customerName = labelledValue(combined, ["お客様のニックネーム", "ニックネーム", "お客様", "purchaser", "購入者", "お名前"]);
  if (customerName) notes.push("ラベルから顧客名を取得");

  // ── 本文 ──────────────────────────────────────────────────
  const { body, note } = extractBody(combined);
  notes.push(note);

  if (!body) {
    // §14「解析失敗時: 受信自体は保存、status = parse_failed、データを捨てない」
    return {
      status: "PARSE_FAILED",
      messageText: null,
      customerName,
      productName,
      productUrl: product?.url ?? null,
      externalProductId: product?.id ?? null,
      adminUrl: admin?.url ?? null,
      notes,
    };
  }

  return {
    status: "PARSED",
    messageText: body,
    customerName,
    productName,
    productUrl: product?.url ?? null,
    externalProductId: product?.id ?? null,
    adminUrl: admin?.url ?? null,
    notes,
  };
}

/**
 * 商品特定のために本文へ足す手がかり。
 *
 * 既存の商品特定(lib/inquiry/productResolver.ts)はURL・SKU・商品名の
 * 断片を本文から拾う設計なので、**メールから取れた商品名とURLを本文へ
 * 添えて渡す**のがいちばん素直。特定ロジックを二重に書かない。
 *
 * 顧客が書いた文章と、メールのメタ情報を混ぜて1つの本文にすると、
 * AIが「顧客が商品URLを送ってきた」と誤解しうるので、呼び出し側は
 * 顧客本文(messageText)と、この特定用テキストを別々に使う。
 */
export function buildProductLookupText(result: MercariMailParseResult): string {
  return [result.productUrl, result.productName, result.messageText].filter(Boolean).join("\n");
}
