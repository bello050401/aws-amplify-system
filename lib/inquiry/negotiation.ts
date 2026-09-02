/**
 * 値下げ交渉の構造化抽出(2026-09-02 指示書 §3)。
 *
 * 純粋関数のみ。DBにも外部にも触らない。
 *
 * ── なぜ決定的な抽出を併用するのか ──────────────────────────────
 *
 * 固定実例:
 *
 *     https://bellointeri.base.shop/items/155832757
 *     こちら2脚で6万円になりませんか
 *
 * この文には「値下げ」「値引き」「安く」「交渉」のいずれも現れない。
 * そのため既存の2つの判定はどちらも交渉として認識できていなかった:
 *
 *   - lib/inquiry/intent.ts の NEGOTIATION キーワード
 *     ["値引き","値下げ","おまけ","安く","割引","交渉","まけて"] → 不一致
 *   - lib/inquiry/discount.ts の detectDiscountIntent の正規表現 → 不一致
 *
 * 結果 intent は OTHER 単独になり、値下げ交渉のルートへ一度も入らず、
 * 「個別の値引き交渉は承っておりません」という一般回答になっていた。
 * (さらに discount.ts 自体、返信パイプラインからは一度も import されて
 *  いなかった —— 値下げエンジンは存在するのに繋がっていなかった。)
 *
 * 「○円になりませんか」「○円なら買いたい」「まとめて○万円」のような
 * **金額の提示そのもの**が交渉の本体なので、金額・数量・提示表現を
 * 決定的に検出する。LLMの自由分類だけに依存すると、同じ問い合わせで
 * 毎回違う経路を通り、外したときに直す手段が無くなる。
 */

/** 「2脚」「2点」「二台」等に使われる助数詞。家具の問い合わせで実際に出るものだけを並べる。 */
const COUNTERS = "脚点個台枚客セット組張本部";

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 全角英数字を半角へ。金額・数量の判定はすべてこれを通してから行う。 */
export function normalizeForNegotiation(text: string): string {
  return text.replace(/[Ａ-Ｚａ-ｚ０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 「二」「十二」程度の漢数字を数値へ。家具の個数なので大きな桁は扱わない。 */
function parseSmallKanjiNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  const m = /^(?:([一二三四五六七八九])?十)?([〇一二三四五六七八九])?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !raw.includes("十"))) {
    return raw.length === 1 && raw in KANJI_DIGITS ? KANJI_DIGITS[raw] : null;
  }
  const tens = raw.includes("十") ? (m[1] ? KANJI_DIGITS[m[1]] : 1) * 10 : 0;
  const ones = m[2] ? KANJI_DIGITS[m[2]] : 0;
  const value = tens + ones;
  return value > 0 ? value : null;
}

export interface ExtractedAmount {
  yen: number;
  /** 本文中の元の表記(管理画面へ「何を読んだか」を出すため)。 */
  raw: string;
}

/**
 * 金額を取り出す。
 *
 * 対応する書き方(実際の問い合わせで使われる形):
 *   60000円 / 60,000円 / 6万円 / 6万 / 6.5万円 / 6万5千円 / 六万円
 *
 * 「円」も「万」も付かない裸の数字は金額として扱わない ——
 * 「2脚」の 2 や商品IDを金額と誤読するため。
 */
export function extractAmounts(text: string): ExtractedAmount[] {
  const s = normalizeForNegotiation(text);
  const found: ExtractedAmount[] = [];
  const seen = new Set<string>();

  const push = (yen: number, raw: string) => {
    if (!Number.isFinite(yen) || yen <= 0) return;
    const key = `${yen}|${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ yen: Math.round(yen), raw });
  };

  // 6万5千円 / 6万5000円 / 6万円 / 6.5万 / 六万円
  const manRe = /([0-9]+(?:\.[0-9]+)?|[〇一二三四五六七八九十]+)\s*万\s*(?:([0-9]+(?:,[0-9]{3})*|[〇一二三四五六七八九十]+)\s*(千)?)?\s*円?/g;
  for (const m of s.matchAll(manRe)) {
    const head = /^[0-9.]+$/.test(m[1]) ? Number(m[1]) : parseSmallKanjiNumber(m[1]);
    if (head == null) continue;
    let yen = head * 10_000;
    if (m[2]) {
      const tailRaw = m[2].replace(/,/g, "");
      const tail = /^[0-9]+$/.test(tailRaw) ? Number(tailRaw) : parseSmallKanjiNumber(tailRaw);
      if (tail != null) yen += m[3] ? tail * 1_000 : tail;
    }
    push(yen, m[0].trim());
  }

  // 60000円 / 60,000円 (「万」を含む表記は上で拾い済みなので除く)
  const yenRe = /(?<![0-9.])([0-9]{3,}(?:,[0-9]{3})*|[0-9]{1,3}(?:,[0-9]{3})+)\s*円/g;
  for (const m of s.matchAll(yenRe)) {
    if (s.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0).includes("万")) continue;
    push(Number(m[1].replace(/,/g, "")), m[0].trim());
  }

  return found;
}

export interface ExtractedQuantity {
  value: number;
  raw: string;
}

/**
 * 数量を取り出す。
 *
 * 「2脚」「2点」「二台」のように**助数詞が付いているもの**だけを数量と
 * みなす。裸の数字は金額・商品ID・寸法と区別が付かない。
 * 「2つ」「2個」も拾う。
 */
export function extractQuantity(text: string): ExtractedQuantity | null {
  const s = normalizeForNegotiation(text);
  const re = new RegExp(`([0-9]{1,3}|[〇一二三四五六七八九十]{1,3})\\s*(?:つ|[${COUNTERS}])`, "g");
  for (const m of s.matchAll(re)) {
    // 「1万円」の 1 を拾わないよう、直後が「万」なら数量ではない。
    const after = s.slice((m.index ?? 0) + m[0].length);
    if (after.startsWith("万")) continue;
    const value = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseSmallKanjiNumber(m[1]);
    if (value != null && value > 0 && value <= 999) return { value, raw: m[0].trim() };
  }
  return null;
}

/**
 * 値下げ交渉を示す表現。
 *
 * 既存の discount.ts の DISCOUNT_PATTERNS(「値下げ」等の明示語)に加えて、
 * **金額の提示そのもの**を交渉として扱うための形を並べる。
 */
const OFFER_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(?:に|へ)\s*(?:は)?\s*(?:なりません|ならない|なりませんか|なりませんでしょうか)/, label: "「〜になりませんか」" },
  { re: /(?:で|に)\s*(?:は)?\s*(?:どう|いかが|可能)/, label: "「〜でいかがですか」" },
  { re: /なら\s*(?:即)?(?:買|購入|決|お迎え)/, label: "「〜なら購入します」" },
  { re: /(?:まとめて|2点以上|複数)/, label: "まとめ買いの申し出" },
  { re: /(?:お?)値段\s*(?:の)?\s*(?:ご)?相談/, label: "「お値段のご相談」" },
  { re: /(?:ご)?予算(?:は|が)?/, label: "予算の提示" },
];

/** 既存 discount.ts と重複する明示的な交渉語(こちらは金額が無くても交渉とみなす)。 */
const EXPLICIT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /値下げ/, label: "「値下げ」" },
  { re: /値引き/, label: "「値引き」" },
  { re: /お?安く(?:な|し|でき)/, label: "「安くなりませんか」" },
  { re: /まけ(?:て|られ)|負けて/, label: "「まけて」" },
  { re: /割引/, label: "「割引」" },
  { re: /(?:価格|値段)交渉/, label: "「価格交渉」" },
  { re: /交渉(?:は)?(?:可能|できま)/, label: "「交渉可能ですか」" },
  { re: /即決/, label: "「即決」" },
  { re: /いくらまで/, label: "「いくらまで」" },
  { re: /どこまで下が/, label: "「どこまで下がりますか」" },
];

export interface NegotiationExtraction {
  /** 値下げ交渉として扱うか。 */
  isNegotiation: boolean;
  /** そう判断した根拠(管理画面の「参照情報」に出す)。 */
  signals: string[];
  /** 数量。助数詞付きで書かれていた場合のみ。 */
  quantity: number | null;
  quantityRaw: string | null;
  /**
   * 顧客が提示した総額。数量が2以上なら「2脚で6万円」の6万円は総額。
   * 数量が分からない/1なら、単価と総額は同じ意味になる。
   */
  requestedTotalPriceYen: number | null;
  /** 総額 ÷ 数量。割り切れない場合も切り捨てず小数を返さない(円未満は切り捨て)。 */
  requestedUnitPriceYen: number | null;
  /** 本文から読み取った金額すべて(複数書かれている場合の確認用)。 */
  amounts: ExtractedAmount[];
}

/**
 * 問い合わせ本文から値下げ交渉の構造を取り出す。
 *
 * 判定は2通り:
 *   A. 明示的な交渉語がある(金額が無くても交渉)
 *   B. 金額の提示 + 提示表現がある(「2脚で6万円になりませんか」)
 *
 * 「6万円です」のように金額だけが書かれていて提示表現が無い場合は
 * 交渉としない —— 単なる事実の記述や、こちらの提示額の復唱でありうる。
 */
export function extractNegotiation(text: string): NegotiationExtraction {
  const s = normalizeForNegotiation(text);
  const signals: string[] = [];

  for (const p of EXPLICIT_PATTERNS) if (p.re.test(s)) signals.push(p.label);
  const explicit = signals.length > 0;

  const amounts = extractAmounts(s);
  const offerHits = OFFER_PATTERNS.filter((p) => p.re.test(s));
  const hasOffer = offerHits.length > 0;
  if (amounts.length > 0 && hasOffer) {
    for (const h of offerHits) signals.push(h.label);
    signals.push(`提示金額 ${amounts.map((a) => a.raw).join(" / ")}`);
  }

  const isNegotiation = explicit || (amounts.length > 0 && hasOffer);

  const quantity = extractQuantity(s);
  if (quantity) signals.push(`数量 ${quantity.raw}`);

  // 金額が複数書かれている場合は**最小**を希望額として扱う。値下げ交渉で
  // 複数の金額が出るのは「27,800円のところ6万円で2脚」のように現行価格を
  // 添えるケースで、顧客の希望はそのうち低い方だから……ではない。
  // 総額のほうが大きいこともある(2脚で6万円 > 単価27,800円)。
  // そこで「提示表現の直前にある金額」を優先し、無ければ最後に現れた
  // 金額を採る —— 日本語では希望額が文末近くに来るため。
  let requestedTotal: number | null = null;
  if (isNegotiation && amounts.length > 0) {
    const offerRe = OFFER_PATTERNS.map((p) => p.re.source).join("|");
    const offerMatch = new RegExp(offerRe).exec(s);
    if (offerMatch && offerMatch.index != null) {
      const before = s.slice(0, offerMatch.index);
      const candidates = amounts.filter((a) => before.includes(a.raw));
      requestedTotal = (candidates.length > 0 ? candidates[candidates.length - 1] : amounts[amounts.length - 1]).yen;
    } else {
      requestedTotal = amounts[amounts.length - 1].yen;
    }
  }

  const requestedUnit =
    requestedTotal != null && quantity && quantity.value > 0 ? Math.floor(requestedTotal / quantity.value) : requestedTotal;

  return {
    isNegotiation,
    signals,
    quantity: quantity?.value ?? null,
    quantityRaw: quantity?.raw ?? null,
    requestedTotalPriceYen: requestedTotal,
    requestedUnitPriceYen: requestedUnit,
    amounts,
  };
}


/**
 * 会話をまたいだ値下げ交渉の引き継ぎ。
 *
 * 実例:
 *
 *     顧客 「(BASE URL) こちら2脚で6万円になりませんか」
 *     BELLO「お届け先の都道府県をお伺いしてもよろしいでしょうか」
 *     顧客 「埼玉県です」            ← この本文だけでは交渉に見えない
 *
 * 「埼玉県です」の1件だけを見ると商品も金額も数量も分からない。直前の
 * 交渉条件を引き継がないと、送料が分かった瞬間に判断できるはずの情報を
 * 毎回失う。
 *
 * ── 引き継ぐ条件を狭くしている理由 ──────────────────────────────
 *
 * 「一度でも値下げ交渉があった会話では、以降ずっと交渉として扱う」に
 * すると、そのあとの「サイズを教えてください」にまで配送先を聞き返す
 * ことになる。指示書§16が名指しで禁止している回帰そのもの。
 *
 * そこで引き継ぐのは **今回の本文が『配送先の回答』であるときだけ**。
 * 直前の質問(都道府県の確認)に対する答えなので、交渉の続きであることが
 * 文脈から確実に言える。それ以外は引き継がない。
 */
export interface NegotiationContext extends NegotiationExtraction {
  /** 今回の本文そのものから読み取れたか(falseなら履歴からの引き継ぎ)。 */
  fromCurrentMessage: boolean;
}

export function resolveNegotiationContext(params: {
  currentText: string;
  /** 会話の直近のやり取り(古い順)。 */
  history: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
  /** 今回の本文から配送先の都道府県が読み取れたか(呼び出し元が shippingIntent で判定して渡す)。 */
  currentHasDestination: boolean;
}): NegotiationContext {
  const current = extractNegotiation(params.currentText);
  if (current.isNegotiation) return { ...current, fromCurrentMessage: true };

  // 引き継ぐのは「配送先の回答」のときだけ(上のコメント参照)。
  if (!params.currentHasDestination) return { ...current, fromCurrentMessage: true };

  for (let i = params.history.length - 1; i >= 0; i--) {
    const m = params.history[i];
    if (m.direction !== "INBOUND") continue;
    const past = extractNegotiation(m.body);
    if (past.isNegotiation) {
      return {
        ...past,
        signals: [...past.signals, "(この会話の過去の問い合わせから引き継ぎ)"],
        fromCurrentMessage: false,
      };
    }
  }
  return { ...current, fromCurrentMessage: true };
}
