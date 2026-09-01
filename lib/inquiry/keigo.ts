/**
 * §4.2/§6 「敬語に整える」。純粋関数のみ。
 *
 * スタッフが書いた内容が**事実の正本**で、Novaの仕事は言い方を整えることだけ。
 * 商品を調べ直したり、送料を計算したり、Web検索したりはしない（§4.2）。
 * その保証は経路そのもの（app/actions/inquiryReply.ts の politenessRewrite）で
 * 与え、ここでは「整えた結果が原文の事実を変えていないか」を機械検査する。
 *
 * 【なぜ検査が要るか】文章生成モデルは、丁寧にする過程で自然と断定を
 * 強める。「確認します」が「対応できます」に、「可能性があります」が
 * 「可能です」になる。これは顧客への約束が変わるということで、
 * 言い回しの調整ではない。
 */

export type KeigoViolationCode =
  | "NUMBER_ADDED"
  | "NUMBER_CHANGED"
  | "AMOUNT_ADDED"
  | "DATE_ADDED"
  | "URL_ADDED"
  | "MODEL_NUMBER_ADDED"
  | "PROMISE_STRENGTHENED"
  | "NEGATION_FLIPPED"
  | "CONTENT_ADDED"
  | "EMPTY_OUTPUT";

export interface KeigoViolation {
  code: KeigoViolationCode;
  /** 管理者向けの説明。顧客には出さない。 */
  detail: string;
}

export interface KeigoCheckResult {
  ok: boolean;
  violations: KeigoViolation[];
}

/** 数量・金額・日付・型番・URLなど、勝手に増やしてはいけない具体値。 */
const AMOUNT_RE = /(?:¥|￥)?\s?\d{1,3}(?:,\d{3})+\s?円?|\d+\s?円/g;
const DATE_RE = /\d{1,4}\s*[年/]\s*\d{1,2}\s*[月/]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?/g;
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const MODEL_RE = /(?<![0-9A-Za-z])(?=[0-9A-Za-z-]*[A-Za-z])(?=[0-9A-Za-z-]*\d)[0-9A-Za-z][0-9A-Za-z-]{2,19}(?![0-9A-Za-z])/g;
/** 単位付きの数値（サイズ・重量など）。 */
const MEASURE_RE = /\d+(?:\.\d+)?\s*(?:cm|センチ|mm|ミリ|m|kg|キロ|g|W|ワット|V|インチ|畳|人掛け)/gi;

/**
 * 約束を強める言い換え。左が原文にあり、右が生成文に現れたら疑う。
 *
 * 完全な言い換え辞書は作れないので、実務で問題になる「確定していない
 * ことを確定として伝える」形だけを押さえる。
 */
const PROMISE_PAIRS: { weak: RegExp; strong: RegExp; label: string }[] = [
  { weak: /確認(?:し|いた)/, strong: /(?:対応|お受け|ご用意)(?:でき|いたし)ます/, label: "「確認します」を「対応できます」へ強めていないか" },
  { weak: /可能性|かもしれ|場合がござ/, strong: /可能で(?:す|ございます)|お受けできます|対応できます/, label: "「可能性があります」を「可能です」へ強めていないか" },
  { weak: /検討/, strong: /(?:承(?:り|ります)|お受けいたします)/, label: "「検討します」を「承ります」へ強めていないか" },
  { weak: /未定|確定していません|分かり次第/, strong: /確定(?:して)?(?:おり|い)ます/, label: "未確定を確定として書いていないか" },
];

function collect(text: string, re: RegExp): string[] {
  return (text.match(re) ?? []).map((m) => m.replace(/\s+/g, ""));
}

/** 数値の集合。桁区切りや全角を吸収して比較する。 */
function numbersIn(text: string): Set<string> {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, "");
  return new Set((normalized.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))));
}

/**
 * 整えた文章が、原文の事実を変えていないかを検査する。
 *
 * 見るのは「増えていないか」が中心。丁寧にする過程で情報が落ちること
 * （例: 挨拶で言い換えられる）は許容するが、原文に無い具体値が増えるのは
 * 事実の創作なので許さない。
 */
export function checkKeigoFidelity(params: { original: string; rewritten: string; allowedGreeting?: string }): KeigoCheckResult {
  const violations: KeigoViolation[] = [];
  const rewritten = (params.rewritten ?? "").trim();
  if (rewritten.length === 0) {
    return { ok: false, violations: [{ code: "EMPTY_OUTPUT", detail: "整えた文章が空です。" }] };
  }

  // 初回挨拶は原文に無くても足してよい（§6.1）。比較対象から外す。
  const comparable = params.allowedGreeting ? rewritten.split(params.allowedGreeting).join(" ") : rewritten;

  const originalNumbers = numbersIn(params.original);
  for (const n of numbersIn(comparable)) {
    if (!originalNumbers.has(n)) {
      violations.push({ code: "NUMBER_ADDED", detail: `原文に無い数値が増えています: ${n}` });
    }
  }

  for (const [re, code, label] of [
    [AMOUNT_RE, "AMOUNT_ADDED", "金額"],
    [DATE_RE, "DATE_ADDED", "日時"],
    [URL_RE, "URL_ADDED", "URL"],
    [MEASURE_RE, "NUMBER_ADDED", "寸法・重量"],
    [MODEL_RE, "MODEL_NUMBER_ADDED", "型番らしき文字列"],
  ] as const) {
    const before = new Set(collect(params.original, re));
    for (const found of collect(comparable, re)) {
      if (!before.has(found)) violations.push({ code, detail: `原文に無い${label}が増えています: ${found}` });
    }
  }

  for (const pair of PROMISE_PAIRS) {
    if (pair.weak.test(params.original) && pair.strong.test(comparable) && !pair.weak.test(comparable)) {
      violations.push({ code: "PROMISE_STRENGTHENED", detail: pair.label });
    }
  }

  // 否定の反転。原文が「できません」なのに「できます」になっていないか。
  const originalNegative = /(?:できません|ございません|不可|お受けできか|承れません)/.test(params.original);
  const rewrittenPositive = /(?:できます|承ります|可能です|ございます)/.test(comparable);
  const rewrittenNegative = /(?:できません|ございません|いたしかね|承れません|difficult)/.test(comparable);
  if (originalNegative && rewrittenPositive && !rewrittenNegative) {
    violations.push({ code: "NEGATION_FLIPPED", detail: "原文の否定が肯定へ反転している可能性があります。" });
  }

  // 分量が大きく増えていたら、言い換えではなく内容が足されている。
  // 具体的な数値が増えていなくても、原文に無い話題（「送料は確認中です」等）が
  // 混ざることが実機で起きた。敬語にすると多少は長くなるので倍率で見る。
  // comparable は挨拶を除いた本文なので、比較の基準も原文だけにする
  // （基準に挨拶ぶんを足すと、短い下書きで1文まるごと足されても
  //   閾値に届かなくなる）。
  const baseLength = params.original.trim().length;
  if (baseLength > 0 && comparable.trim().length > baseLength * 1.8 + 25) {
    violations.push({
      code: "CONTENT_ADDED",
      detail: `整えた文章が原文に対して長くなりすぎています（${params.original.trim().length} → ${comparable.trim().length}文字）。内容が足された可能性があります。`,
    });
  }

  // 重複を畳む（同じ数値が複数回現れると同じ指摘が並ぶ）。
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.code}|${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: unique.length === 0, violations: unique };
}

/**
 * §6.3 曖昧な原文。
 *
 * 意味が複数に取れる文は、Novaが「良さそうな方」に決めてしまう。
 * 顧客向けの文章とは別に、スタッフへ注意として出すための検出。
 */
const AMBIGUOUS_PATTERNS: { re: RegExp; note: string }[] = [
  { re: /たぶん|おそらく|かも|多分/, note: "推量の表現が含まれています。確定した内容か確認してください。" },
  { re: /^[^。]{0,15}$/, note: "文が短く、前提が省略されている可能性があります。" },
  { re: /それ|あれ|そちら|あちら|例の/, note: "指示語が何を指すか、文章だけでは分かりません。" },
  { re: /(?:早め|近日|そのうち|後ほど)(?:に)?/, note: "時期の表現が曖昧です。日付が必要か確認してください。" },
];

export function detectAmbiguity(original: string): string[] {
  const trimmed = original.trim();
  return AMBIGUOUS_PATTERNS.filter((p) => p.re.test(trimmed)).map((p) => p.note);
}

/**
 * §6.1 初回返信かどうか。
 *
 * **実際に送信した返信**が1件も無ければ初回。AI下書きがあるだけでは
 * 「返信済み」にしない（仕様書が明示している）。判定材料を呼び出し側から
 * 渡してもらう純粋関数にして、テストできるようにする。
 */
export function isFirstOutgoingReply(messages: { direction: "INBOUND" | "OUTBOUND"; deliveryStatus: string }[]): boolean {
  return !messages.some((m) => m.direction === "OUTBOUND" && (m.deliveryStatus === "SENT" || m.deliveryStatus === "SENDING"));
}

/** 敬語モードのシステムプロンプト。事実を変えないことを最優先に置く。 */
export function buildKeigoSystemPrompt(): string {
  return [
    "あなたは中古家具・インテリアを扱う「BELLO」の販売担当者です。",
    "担当者が書いた返信の下書きを、お客様へお送りできる丁寧な日本語に整えてください。",
    "",
    "【最優先の原則】",
    "- 下書きの内容が事実の正本です。意味・条件・数字・固有名詞を変えないでください。",
    "- 下書きに無い情報を足さないでください。金額・送料・在庫・仕様・サイズ・素材・型番・納期・配送日・営業時間・保証・値引き・返金条件は特にそうです。",
    "- 断定の強さを変えないでください。「確認します」を「対応できます」に、「可能性があります」を「可能です」にしないでください。",
    "- 下書きの意味が複数に取れる場合は、勝手に一つへ決めず、曖昧なまま丁寧にしてください。",
    "- 商品を調べたり、送料を計算したりはしません。下書きに書かれていることだけを扱ってください。",
    "",
    "【文体】",
    "- 「です・ます」で統一し、過剰な謙譲表現を重ねないでください。",
    "- 署名・宛名・件名は書かず、本文だけを出力してください。",
  ].join("\n");
}

/**
 * 敬語モードのユーザープロンプト。
 *
 * **会話履歴を渡さない。** 最初は文脈の参考として直近数件を入れていたが、
 * Staging実機で「かしこまりました。よろしくお願いします。」を整えた結果に
 * 「送料につきましては現在確認中です」という、原文に無い内容が会話履歴から
 * 混ざった。具体的な数値は増えていないので値の検査は通ってしまう。
 * 渡さなければ混ざりようがない。
 *
 * 敬語モードは「スタッフが書いたことを言い換える」だけの経路なので、
 * 文脈を読む必要がそもそも無い。
 */
export function buildKeigoUserPrompt(params: {
  original: string;
  knowledgeExcerpts: { title: string; excerpt: string }[];
  greeting: string | null;
}): string {
  const sections: string[] = [];
  if (params.knowledgeExcerpts.length > 0) {
    sections.push(
      `BELLO_STYLE_RULES:\n${params.knowledgeExcerpts.map((k) => `[${k.title}]\n${k.excerpt}`).join("\n\n")}`,
    );
  }
  if (params.greeting) {
    sections.push(`FIRST_REPLY_GREETING(この返信は初回なので、本文の前にこの挨拶を置いてください):\n${params.greeting}`);
  } else {
    sections.push("FIRST_REPLY_GREETING:\n(なし。2回目以降の返信なので「初めまして」は書かないでください)");
  }
  sections.push(`STAFF_DRAFT(事実の正本。ここに書かれていることだけを整える):\n${params.original}`);
  sections.push("上記の下書きを、意味を変えずに整えた本文だけを出力してください。");
  return sections.join("\n\n");
}
