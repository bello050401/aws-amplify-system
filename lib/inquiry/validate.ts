/**
 * §40 生成後の事実検証。純粋関数のみ。
 *
 * 【既存実装を再利用する】lib/ai/productIntro/factSafety.tsのcheckFactSafety
 * が、社内スコア・在庫数・SKU・他人の氏名/住所・捏造ブランド・
 * プロンプト漏洩の検査を既に持っている。返信文も「顧客が読む文章」で
 * あることは出品コピーと同じなので、同じ検査を通す。
 *
 * このファイルが足すのは、**返信案に固有の**検査だけ:
 *   - 送料の金額を、根拠が無いのに書いていないか(§40「送料創作」)
 *   - 不明としたはずの項目を断定していないか(§40「不明事項断言」)
 *   - 外部ページの文章を長くそのまま写していないか(§9.4)
 *   - 在庫DBに無い寸法を創作していないか(§40「ソースにない寸法創作」)
 */
import { checkFactSafety, type FactSafetyViolation } from "@/lib/ai/productIntro/factSafety";
import type { CustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { JAPAN_PREFECTURES } from "@/lib/shipping/prefectures";
import { findLongVerbatimCopy } from "./research/sanitize";
import type { UnresolvedFact } from "./types";

export type ReplyValidationCode =
  | "FABRICATED_SHIPPING_FEE"
  | "ASSERTED_UNRESOLVED_FACT"
  | "EXTERNAL_VERBATIM_COPY"
  | "FABRICATED_DIMENSION"
  | "FACT_SAFETY"
  /** 既に分かっていることを顧客へ尋ねている。 */
  | "ASKS_KNOWN_FACT"
  /** 回答せずにSNS・ホームページへ誘導している。 */
  | "DEFLECTS_TO_EXTERNAL_CHANNEL"
  /** ご希望に沿えるのに、お断り・お詫びを書いている。 */
  | "UNNECESSARY_REFUSAL"
  /** 受け取っていない添付(写真等)を受け取った前提で書いている。 */
  | "CLAIMS_UNSENT_ATTACHMENT";

export interface ReplyValidationViolation {
  code: ReplyValidationCode;
  /** 管理者向けの説明。顧客には出さない。 */
  detail: string;
}

export interface ReplyValidationResult {
  ok: boolean;
  violations: ReplyValidationViolation[];
}

/** 「12,000円」「12000 円」「¥12,000」を金額とみなす。 */
const MONEY_PATTERN = /(?:¥|￥)?\s?\d{1,3}(?:,\d{3})+\s?円?|\d{3,7}\s?円/g;

/** 寸法らしき記述。「幅120cm」「120×80cm」等。 */
const DIMENSION_PATTERN = /\d{2,4}(?:\.\d+)?\s*(?:cm|センチ|ｃｍ|mm|ミリ)/gi;

export function validateReplyDraft(params: {
  output: string;
  /** 顧客向けに認めた商品の事実。 */
  facts: CustomerSafeFacts;
  stockQuantity?: number | null;
  sku?: string | null;
  /** 送料の金額を書いてよい場合のみ、その金額(円)。書いてはいけない場合はnull。 */
  allowedShippingFeeYen: number | null;
  /**
   * 送料以外に、顧客へ提示してよい確定金額(2026-09-03 実測の不具合)。
   *
   * 値下げ交渉では、7%引き後の単価・数量合計を**確定値として提示する**運用
   * (lib/inquiry/negotiationService.ts の customerSafeFacts)。ところが検査は
   * 送料1件しか許可していなかったため、運用どおりに書いた返信が
   * 「根拠のない金額」として弾かれ、3回作り直して**返信案が1つも作られ
   * なかった**。金額はコード側で確定させているので、その値だけを通す。
   */
  allowedMoneyYen?: number[];
  /** 分からないままにした項目。 */
  unresolved: UnresolvedFact[];
  /**
   * 既に確定している配送先都道府県(2026-09-03 実測の不具合)。
   *
   * 実機で「埼玉県でこちら2脚で6万円になりませんか」に対し、
   * 「まずは配送先の都道府県を教えていただけますでしょうか」と返す返信案が
   * 出た。お客様が書いたことを読んでいないと受け取られる。
   * 返信ルール(「配送先が不明な値下げ交渉」)が意図と違う場面で効いていた
   * ためだが、原因がどこであれ**既に分かっていることを尋ねる返信は出さない**。
   */
  knownDestinationPrefecture?: string | null;
  /**
   * お客様のご希望額が、こちらの提示額を上回っているか(2026-09-03 実測)。
   *
   * true のとき、お断りする理由が無い。実機では「ご希望6万円 / 提示
   * 46,128円＋送料4,510円」という**希望より安い**状況で、
   * 「お客様のご希望に沿えないことをお詫び申し上げます」と返す返信案が
   * 3回続けて出た。金額はコード側で確定しているので、判断を文面の検査でも
   * 押さえる —— プロンプトへ判断結果を渡すだけでは従わなかった。
   */
  requestIsWithinOffer?: boolean;
  /**
   * 今回のメッセージに添付が実際にあったか(2026-09-03 実測)。
   *
   * false のとき、「お送りいただいた写真」のように受け取った前提で書いては
   * いけない。実機で、写真の無い問い合わせ(メルカリShopsの取引メッセージ)に
   * 対して「お送りいただいた写真を確認し、商品の状態を詳しく調査いたします」
   * と返す返信案が出た。お客様は写真を送っていないので、読んだ側は話が
   * 通じていないと受け取る。
   */
  customerSentAttachment?: boolean;
  /** 外部から取得した本文(sanitize済み)。長文の引き写し検査に使う。 */
  externalTexts: string[];
  /** 生成文に出てよい寸法の文字列(在庫DBの寸法・外部調査で確認できた寸法)。 */
  allowedDimensionText: string[];
  /**
   * 返信の根拠として認めた文章(ナレッジ文書の抜粋・商品の事実)。
   * 「その記述が根拠に書いてあるか」を判定するために使う。
   */
  groundedTexts?: string[];
  maxLength?: number;
}): ReplyValidationResult {
  const violations: ReplyValidationViolation[] = [];
  const output = params.output ?? "";

  // ── 送料の創作 ────────────────────────────────────────────────
  const moneyMentions = output.match(MONEY_PATTERN) ?? [];
  // 送料と、値下げ交渉で提示してよい確定金額。どちらもコード側で計算した
  // 値だけで、AIに計算させた数字は1つも入らない。
  const allowedAmounts = [params.allowedShippingFeeYen, ...(params.allowedMoneyYen ?? [])].filter(
    (v): v is number => v != null,
  );
  const allowedForms = allowedAmounts.flatMap((amount) =>
    [amount.toLocaleString("ja-JP"), String(amount)].flatMap((n) => [n, `${n}円`, `¥${n}`, `￥${n}`]),
  );
  const unauthorizedMoney = moneyMentions.filter((mention) => {
    const normalized = mention.replace(/[¥￥\s]/g, "");
    return !allowedForms.some((form) => normalized === form.replace(/[¥￥\s]/g, ""));
  });
  for (const mention of unauthorizedMoney) {
    violations.push({ code: "FABRICATED_SHIPPING_FEE", detail: `根拠のない金額が含まれています: ${mention.trim()}` });
  }

  const factSafety = checkFactSafety({
    output,
    facts: params.facts,
    stockQuantity: params.stockQuantity,
    sku: params.sku,
    maxLength: params.maxLength ?? 1200,
  });
  for (const v of factSafety.violations) {
    // 出品コピーでは金額に触れること自体が違反だが(価格は別項目で管理
    // されるものなので、説明文に混ざると実際の販売価格と食い違う)、
    // 問い合わせ返信では話が違う。「送料はいくらですか」に答えるのが
    // 目的で、その金額は配送データベースから引いた確定値だからだ。
    // 根拠のある金額しか書かれていないことは、すぐ上で既に確かめている
    // —— そのうえでPRICE_CLAIMを立てると、正しい回答が永久に通らない。
    if (v.code === "PRICE_CLAIM" && allowedAmounts.length > 0 && unauthorizedMoney.length === 0) continue;

    // 住所も同じ理由で扱いが変わる。出品コピーに住所が出るのは、
    // 商品メモに紛れ込んだ**顧客の住所**が漏れた場合しかない。一方、
    // 「お店はどこにありますか」への返信で住所を書かないなら、答えて
    // いないのと同じ。
    //
    // 区別する基準は「その住所がどこから来たか」。社内文書(基本情報.txt)
    // に書かれている住所なら、それはBELLO自身の所在地として登録された
    // 事実であり、出してよい。根拠のどこにも無い住所は、出典不明の
    // 個人情報なので従来どおり弾く。
    if (v.code === "PERSONAL_DATA" && isPersonalDataGrounded(output, params.groundedTexts ?? [])) continue;

    violations.push({ code: "FACT_SAFETY", detail: describeFactSafety(v) });
  }

  // ── 既に分かっていることを尋ねていないか ────────────────────
  if (params.knownDestinationPrefecture) {
    // 「都道府県を教えてください」系。地名そのものを含む文(「埼玉県への
    // 配送ですね」)は弾かないよう、**尋ねる形**だけを見る。
    const asksPrefecture =
      /(?:お届け先|配送先|発送先|送り先)[^。\n]{0,20}(?:都道府県|地域|エリア)[^。\n]{0,20}(?:教え|お伺い|ご記入|ご連絡|お知らせ)/.test(output) ||
      /(?:都道府県|配送先の地域)[^。\n]{0,15}(?:を)?[^。\n]{0,10}(?:教えて|お伺いし|ご教示)/.test(output);
    if (asksPrefecture) {
      violations.push({
        code: "ASKS_KNOWN_FACT",
        detail:
          `お届け先は既に「${params.knownDestinationPrefecture}」と分かっています。都道府県を尋ねてはいけません。` +
          "お届け先が分かっている前提で書き、送料や金額が確定していない場合は「確認のうえ改めてご案内いたします」としてください。",
      });
    }
  }

  // ── 受け取っていない添付に言及していないか ──────────────────
  if (params.customerSentAttachment === false) {
    // 「写真を送ってください」と依頼する形は弾かない。**受け取った前提**の
    // 書き方だけを見る。
    const claimsAttachment =
      /(?:お送り|ご送付|添付|ご提供)いただ(?:いた|きました)[^。\n]{0,10}(?:写真|画像|お写真|動画)/.test(output) ||
      /(?:写真|画像|お写真|動画)[^。\n]{0,8}(?:を)?(?:拝見|確認)(?:いた)?し(?:ました|、|た)/.test(output);
    if (claimsAttachment) {
      violations.push({
        code: "CLAIMS_UNSENT_ATTACHMENT",
        detail:
          "このお問い合わせに写真・画像の添付はありません。受け取った前提で書いてはいけません。" +
          "必要なら「お写真をお送りいただけますでしょうか」と依頼する形にしてください。",
      });
    }
  }

  // ── 断る必要が無いのに断っていないか ────────────────────────
  if (params.requestIsWithinOffer) {
    const refuses =
      /(?:ご希望|ご要望)[^。\n]{0,12}(?:沿え|添え|応じられ|お受けでき|承れ|対応でき)(?:ず|ない|ませ)/.test(output) ||
      /(?:ご提示|ご案内|お値引き)[^。\n]{0,10}(?:できません|いたしかねます|difficult)/.test(output) ||
      /(?:誠に|大変)?申し訳(?:ございません|ありません)[^。\n]{0,20}(?:ご希望|ご要望|お値引き)/.test(output);
    if (refuses) {
      violations.push({
        code: "UNNECESSARY_REFUSAL",
        detail:
          "お客様のご希望額は、こちらからご提示できる金額を上回っています。お断りやお詫びを書いてはいけません。" +
          "ご希望の範囲でご案内できることを、確定値そのままで伝えてください。",
      });
    }
  }

  // ── 回答せずに外部チャネルへ誘導していないか ────────────────
  //
  // 「SNSやホームページへ誘導して回答を避けない」はプロンプトで禁じて
  // いるが、実機で「BELLOのホームページやSNSアカウントにて最新のセール
  // 情報やキャンペーン情報をご確認ください」という文が出た。実在を
  // 確認していないキャンペーンの示唆でもあり、二重に良くない。
  if (/(?:SNS|ホームページ|公式サイト|インスタ|Instagram|X(旧Twitter)|Twitter)/i.test(output)) {
    violations.push({
      code: "DEFLECTS_TO_EXTERNAL_CHANNEL",
      detail:
        "SNS・ホームページ・SNSアカウントへの誘導を書いてはいけません。" +
        "お問い合わせにはこの返信の中で答え、答えられないことは「確認のうえ改めてご案内いたします」としてください。",
    });
  }

  // ── 不明としたはずの項目の断定 ──────────────────────────────
  for (const fact of params.unresolved) {
    if (assertsUnresolvedField(output, fact.field)) {
      violations.push({
        code: "ASSERTED_UNRESOLVED_FACT",
        detail: `確認できていない「${fact.field}」について断定的に述べています。`,
      });
    }
  }

  // ── 外部文章の長文コピー ────────────────────────────────────
  for (const text of params.externalTexts) {
    const copied = findLongVerbatimCopy(output, text);
    if (copied) {
      violations.push({
        code: "EXTERNAL_VERBATIM_COPY",
        detail: `外部ページの文章を長くそのまま引き写しています(${copied.slice(0, 30)}…)。`,
      });
      break;
    }
  }

  // ── 寸法の創作 ────────────────────────────────────────────────
  const dimensionMentions = output.match(DIMENSION_PATTERN) ?? [];
  if (dimensionMentions.length > 0) {
    const allowedNumbers = new Set(
      params.allowedDimensionText.flatMap((t) => (t.match(/\d{1,4}(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)))),
    );
    for (const mention of dimensionMentions) {
      const num = mention.match(/\d{1,4}(?:\.\d+)?/)?.[0];
      if (num && !allowedNumbers.has(String(Number(num)))) {
        violations.push({
          code: "FABRICATED_DIMENSION",
          detail: `根拠のない寸法が含まれています: ${mention.trim()}`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 「不明」としたはずの項目について断定しているか。
 *
 * 項目名の近くに肯定・否定の断定表現があるかを見る。文脈を完全に読む
 * ことはできないので、「確認」「お調べ」等のヘッジ表現が同じ文にあれば
 * 断定とはみなさない —— 「耐荷重については確認が必要です」を誤検出しない
 * ためで、ここは見逃す側へ倒す(顧客向けの害は、断定より誤って弾く方が
 * 小さいという判断は取らない。生成し直しのコストが実務上重いため)。
 */
const ASSERTION_MARKERS = ["です", "ます", "できます", "可能です", "対応しています", "ございます"];
const HEDGE_MARKERS = ["確認", "お調べ", "断定", "分かりかね", "わかりかね", "いたしかね", "承っておりません", "不明"];

export function assertsUnresolvedField(output: string, field: string): boolean {
  if (!field || field.length < 2) return false;
  for (const sentence of output.split(/[。\n]/)) {
    if (!sentence.includes(field)) continue;
    if (HEDGE_MARKERS.some((h) => sentence.includes(h))) continue;
    if (ASSERTION_MARKERS.some((a) => sentence.includes(a))) return true;
  }
  return false;
}

/**
 * 生成文に現れた「住所・電話番号らしき記述」が、すべて根拠の文章に
 * 由来しているか。
 *
 * 【なぜ「根拠テキストにも個人情報がある」で済ませないか】それだと、
 * ナレッジ文書のどこかに住所さえあれば、生成文にどんな住所を書いても
 * 通ってしまう。実際に書かれた記述そのものが根拠の中にあることを見る。
 *
 * 表記ゆれ(全角数字・空白)を吸収してから比較する。番地の書き方が
 * 「939-1」と「939−1」で違うだけで弾かれるのは、正しさに寄与しない。
 */
export function isPersonalDataGrounded(output: string, groundedTexts: string[]): boolean {
  const mentions = extractPersonalDataMentions(output);
  if (mentions.length === 0) return false;
  const grounded = groundedTexts.map(normalizeForGrounding).join(" | ");
  return mentions.every((m) => grounded.includes(normalizeForGrounding(m)));
}

/**
 * looksLikePersonalDataが見ているのと同じ形を、実際の文字列として取り出す。
 *
 * 住所の末尾は「ひらがなが現れたら終わり」とする。`[^\s、。]{0,20}` の
 * ように貪欲に取ると「…南永井939-1です」まで含んでしまい、根拠の文書に
 * 書かれている「…南永井939-1」と一致しなくなる。日本語の住所表記に
 * ひらがなは現れない(「の」を含む地名はあるが、番地の後には来ない)。
 */
function extractPersonalDataMentions(text: string): string[] {
  const t = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const addressTail = "[\\u4E00-\\u9FFF\\u30A0-\\u30FFA-Za-z0-9\\-−ー－丁目番地条]*";
  // 都道府県名は閉じた集合なので、そのまま並べる。
  // `[^\s]{2,3}県` のようなワイルドカードだと、「所在地は埼玉県…」から
  // 「は埼玉県…」を切り出してしまい、根拠の文書に書かれている
  // 「埼玉県…」と一致しなくなる(実際にそうなった)。
  const prefectures = JAPAN_PREFECTURES.join("|");
  const patterns = [
    /\d{3}\s*[-−ー－]\s*\d{4}/g,
    /0\d{1,4}[-−ー－]\d{1,4}[-−ー－]\d{3,4}/g,
    new RegExp(`(?:${prefectures})\\s*[^\\s]{1,12}?(?:市|区|郡|町|村)${addressTail}`, "g"),
    new RegExp(`\\d+\\s*丁目${addressTail}`, "g"),
  ];
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) found.push(m[0]);
  }
  return found;
}

function normalizeForGrounding(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[-−ー－]/g, "-")
    .replace(/[\s　]/g, "");
}

function describeFactSafety(v: FactSafetyViolation): string {
  return `${v.code}: ${v.detail}`;
}

/**
 * §40 bounded regeneration。無限に作り直さない。
 *
 * 2→3。検査項目を増やした(ASKS_KNOWN_FACT / DEFLECTS_TO_EXTERNAL_CHANNEL)
 * ぶん、1回の生成が通る確率が下がる。実測(2026-09-03)では値下げ交渉で
 * 2回とも別の理由で弾かれ、**返信案が1つも作られない**ところまで行った。
 * 検査を緩めるのではなく、作り直しの回数を1回増やして対応する ——
 * 弾いた理由は次の試行へ渡しているので、回数を増やすほど通りやすくなる。
 */
export const REPLY_MAX_GENERATION_ATTEMPTS = 3;
