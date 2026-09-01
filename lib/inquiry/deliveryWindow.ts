/**
 * §14〜§15 配送希望日の業務ルール。純粋関数のみ。
 *
 * BELLOの原則は「商品到着は購入後2週間以内」。これは文章のルールでは
 * なく、14日という境界で**人間の判断が要るかどうかが変わる**ルールなので、
 * 日数の判定はコードで行い、Novaには結果の説明だけをさせる（§43）。
 *
 * Novaに「何日後か」を数えさせない。日付の解釈は言語モデルが最も
 * 間違えやすい種類の処理で、しかも間違えたときに「対応できます」と
 * 断定してしまう方向へ倒れる。
 */

export type DeliveryWindowState =
  /** 0〜14日。原則対応可能として案内してよい。 */
  | "WITHIN_STANDARD_WINDOW"
  /** 15日以上。AIだけで可否を決めない。 */
  | "HUMAN_REVIEW_REQUIRED"
  /** 判定に必要な日付が足りない。 */
  | "DATE_INFO_REQUIRED";

/** §14 標準のお預かり期間。 */
export const STANDARD_DELIVERY_WINDOW_DAYS = 14;

export interface DeliveryWindowInput {
  /** 購入日、または合理的に確定した購入予定日。 */
  purchaseDate: Date | null;
  /** 希望到着日。 */
  requestedDeliveryDate: Date | null;
}

export interface DeliveryWindowResult {
  state: DeliveryWindowState;
  /** 購入日から希望到着日までの日数。判定できない場合はnull。 */
  days: number | null;
  /** 何が足りないか（DATE_INFO_REQUIREDのとき）。顧客への確認文の材料。 */
  missing: ("purchaseDate" | "requestedDeliveryDate")[];
}

/**
 * 日数の差を「日単位」で数える。
 *
 * 時刻の差ではなく暦日の差で数える。9/1 23:00購入・9/15 09:00希望を
 * 「13.4日」として14日以内に含めてしまうと、境界の意味が変わる。
 * 日本時間の暦日で切り出す。
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const toJstDay = (d: Date) => {
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  };
  return Math.round((toJstDay(to) - toJstDay(from)) / 86_400_000);
}

export function evaluateDeliveryWindow(input: DeliveryWindowInput): DeliveryWindowResult {
  const missing: ("purchaseDate" | "requestedDeliveryDate")[] = [];
  if (!input.purchaseDate) missing.push("purchaseDate");
  if (!input.requestedDeliveryDate) missing.push("requestedDeliveryDate");
  if (missing.length > 0) return { state: "DATE_INFO_REQUIRED", days: null, missing };

  const days = calendarDaysBetween(input.purchaseDate!, input.requestedDeliveryDate!);
  // 過去日を希望された場合も、AIに勝手な解釈をさせず人間へ回す。
  if (days < 0) return { state: "HUMAN_REVIEW_REQUIRED", days, missing: [] };
  if (days <= STANDARD_DELIVERY_WINDOW_DAYS) return { state: "WITHIN_STANDARD_WINDOW", days, missing: [] };
  return { state: "HUMAN_REVIEW_REQUIRED", days, missing: [] };
}

/**
 * §14 配送希望日の問い合わせかどうか。
 *
 * ここが偽陽性だと、配送と関係ない問い合わせで日付確認の文が混ざる。
 * 「いつ」「日」だけでは広すぎるので、配送・到着・受け取りの語と
 * 組み合わせる。
 */
const DELIVERY_DATE_PATTERNS = [
  /(?:配送|発送|お?届け|到着|受け取り|受取|納品|搬入)[^。]{0,10}(?:希望|指定|日|いつ|可能)/,
  /(?:いつ|何日|何週間|いつ頃)[^。]{0,10}(?:届|到着|配送|発送)/,
  /(?:預かって|保管して|取り置き)/,
  /(?:来月|再来月|[0-9０-９]{1,2}\s*(?:ヶ月|か月|カ月|ケ月))[^。]{0,10}(?:後|先)/,
];

export function detectDeliveryDateIntent(text: string): boolean {
  return DELIVERY_DATE_PATTERNS.some((re) => re.test(text));
}

/**
 * 問い合わせ本文から希望到着日を読み取る。
 *
 * 読み取れなければnull。**推測しない** —— 「来週あたり」のような曖昧な
 * 表現を特定の日付に決めてしまうと、14日境界の判定がその推測に乗る。
 * 曖昧なものはDATE_INFO_REQUIREDへ倒すのが正しい。
 */
export function extractRequestedDeliveryDate(text: string, now: Date = new Date()): Date | null {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // 「2026年3月15日」「3月15日」「3/15」
  const ymd = normalized.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (ymd) {
    const year = ymd[1] ? Number(ymd[1]) : inferYear(Number(ymd[2]), Number(ymd[3]), now);
    return jstDate(year, Number(ymd[2]), Number(ymd[3]));
  }
  const slash = normalized.match(/(?<![0-9/])(\d{1,2})\s*\/\s*(\d{1,2})(?![0-9/])/);
  if (slash) {
    const year = inferYear(Number(slash[1]), Number(slash[2]), now);
    return jstDate(year, Number(slash[1]), Number(slash[2]));
  }

  // 「○日後」「○週間後」——起点が明確なので日付に落とせる。
  const daysLater = normalized.match(/(\d{1,3})\s*日\s*(?:後|以内)/);
  if (daysLater) return addDays(now, Number(daysLater[1]));
  const weeksLater = normalized.match(/(\d{1,2})\s*週間\s*(?:後|以内)/);
  if (weeksLater) return addDays(now, Number(weeksLater[1]) * 7);

  // 「1ヶ月後」「来月」等は幅がありすぎる。日付として確定させない
  //（§14.3 のDATE_INFO_REQUIREDか、§14.2のHUMAN_REVIEWで扱う）。
  return null;
}

/**
 * 月日だけ書かれている場合の年。
 *
 * 「3月15日」と書かれたとき、それが今年か来年かは文脈による。既に
 * 過ぎている月日なら翌年とみなす —— 過去日として扱うと、配送希望日が
 * 常にHUMAN_REVIEWへ落ちる。
 */
function inferYear(month: number, day: number, now: Date): number {
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = jstNow.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const today = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate());
  return candidate < today ? year + 1 : year;
}

function jstDate(year: number, month: number, day: number): Date {
  // JSTの0時をUTCで表す。
  return new Date(Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000);
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

/** 顧客向けに書いてよい内容の骨子。文章化はNovaが行う。 */
export function deliveryWindowGuidance(result: DeliveryWindowResult): string {
  switch (result.state) {
    case "WITHIN_STANDARD_WINDOW":
      return "通常のお届け期間（ご購入後2週間以内）に収まるため、原則としてご希望に沿う形で手配できる見込みである旨を伝える。ただし配送業者の空き状況の確定を約束しない。";
    case "HUMAN_REVIEW_REQUIRED":
      return "通常のお預かり期間を超えるため、可否を確認のうえ改めて案内する旨だけを伝える。対応可能・お預かりできる等の確定的な回答はしない。";
    case "DATE_INFO_REQUIRED":
      return "ご希望の到着日（およびご購入予定日）を確認する内容にする。日数を推測して回答しない。";
  }
}
