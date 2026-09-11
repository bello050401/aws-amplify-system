/**
 * 質問単位の回答計画(AnswerPlan)。純粋関数のみ —— 新しいAI呼び出しは
 * 一切増やさない(§コスト最優先)。DBにも外部にも触らないので
 * scripts/verify-inquiry-answer-plan.tsから直接テストできる。
 *
 * ── 何のためにあるか ────────────────────────────────────────────────
 *
 * 既存のパイプライン(pipeline.ts)は「1通のメッセージ全体」を単位に
 * intent(種別)を判定し、unresolved(未解決事実)を積む。これは
 * 「どの情報源を引くか」を決めるには十分だが、複数質問が1通に混ざった
 * とき、**どの質問がまだ答えられていないか**を個別に追える構造を持たない。
 * 実際に起きうる事故:
 *
 *   顧客「サイズと素材と送料と型番を教えてください」
 *   BELLO「サイズは幅120cmです。送料はご住所が分かり次第ご案内します。」
 *
 * 素材と型番への回答が丸ごと抜けても、生成文だけを見ていては気づけない。
 * このファイルは、質問ごとに
 *   questionId / topic / evidenceRefs / status / answerConstraints
 * を持つ計画を組み立て、生成後にその計画と本文を突き合わせて
 * 「答えていなさそうな質問」を検出する。
 *
 * ── 既存ロジックとの関係(再実装しない) ──────────────────────────────
 *
 *  - 質問の話題(topic)判定は intent.ts の extractIntents をそのまま使う。
 *    新しいキーワード表は作らない。
 *  - 「何が分かっていないか」は pipeline.ts が既に積んでいる
 *    UnresolvedFact[](型番の食い違い・送料に必要な情報の不足・外部調査の
 *    未確認 等)をそのまま入力として受け取る。ここで新しく
 *    「何が未解決か」を判定し直すことはしない —— 重複判定は片方だけ直る
 *    事故のもとになる(negotiation.tsのコメントと同じ理由)。
 *  - 「既に回答済みの情報」は conversationContext.ts の knownFacts をそのまま
 *    受け取る。再質問の抑止そのものは、既存の検査
 *    (validate.ts の ASKS_KNOWN_FACT)に任せる —— ここでは「答えなくて
 *    よい(=もう分かっている)」という位置づけの AnswerPlan 項目を作るだけ。
 *
 * ── 顧客原文を保持しない ────────────────────────────────────────────
 *
 * AnswerPlanItem は質問文そのもの(顧客原文)を一切保持しない。持つのは
 * questionId(連番)・topic(列挙型)・evidenceRefs(在庫DBの項目ラベル等)・
 * status・answerConstraints(定型文)だけで、どれも顧客の書いた文章では
 * ない。この計画は ReplyEvidence(DB保存)に載るため、ここに原文を
 * 混ぜると「顧客原文を追加ログへ保存しない」という制約に反する。
 */
import { extractIntents, requiresProduct } from "./intent";
import type { InquiryIntent, UnresolvedFact } from "./types";

export type AnswerPlanStatus = "ANSWERABLE" | "CONFLICT" | "NEEDS_CHECK";

export interface AnswerPlanItem {
  /** この問い合わせの中での通し番号("Q1"等)。顧客原文への参照は持たない。 */
  questionId: string;
  topic: InquiryIntent;
  status: AnswerPlanStatus;
  /** 回答の根拠にしてよい事実の**ラベル**(値ではなく項目名)。例: "サイズ", "型番"。 */
  evidenceRefs: string[];
  /** 生成時に守らせたい制約(定型文。顧客原文は含まない)。 */
  answerConstraints: string[];
}

export interface AnswerPlan {
  items: AnswerPlanItem[];
  /**
   * 実際に検出した質問の件数(トピック単位の重複除去より前の値)。
   *
   * items は「話題(topic)ごとに1件」にまとめてあるため、items.length は
   * **話題の種類数**であって**質問の件数**ではない。「座面の幅を教えて
   * ください。高さも教えてください。」は SIZE 話題が2回登場するが、
   * items 上は SIZE 1件にまとめられる —— これをそのまま件数として
   * buildAnswerPlanGuidance へ渡すと「実質1件です」と断定してしまい、
   * 高さへの質問が案内から消えたように見える返信量制御になる(実測の
   * 指摘)。questionCount は話題の重複を除去する前の出現回数の合計で、
   * 「同じ話題への複数質問」を1件に丸めない。
   */
  questionCount: number;
}

/**
 * ReplyEvidence(管理画面の参照情報)へそのまま載せる形。
 *
 * items はAnswerPlanそのもの、coverageは生成後検査の結果、
 * ungroundedPromisesは根拠の無い約束の検出結果。**顧客への返信本文には
 * 一切渡らない**(types.ts の ReplyEvidence.answerPlan のコメント参照)。
 */
export interface AnswerPlanEvidence {
  items: AnswerPlanItem[];
  coverage: AnswerPlanCoverageItem[];
  ungroundedPromises: string[];
}

export interface BuildAnswerPlanParams {
  /** 顧客の問い合わせ本文(normalizeMessage済みのもの)。分割にのみ使い、保存はしない。 */
  messageText: string;
  /** この問い合わせに対応する商品が特定できているか。 */
  hasProduct: boolean;
  /** 顧客へ回答してよい事実のラベル一覧(trustedProductFactsのlabel)。 */
  trustedFactLabels: string[];
  /** この会話で既に確定していて、聞き直してはいけない項目のラベル一覧(knownFactsのlabel)。 */
  knownFactLabels: string[];
  /** 既存ロジックが既に判定した未解決事実(型番の食い違い・送料情報の不足など)。 */
  unresolved: UnresolvedFact[];
}

/**
 * 問い合わせ本文を、質問らしい単位に分ける。
 *
 * 形態素解析器は導入しない(references.tsの extractProductNameFragments と
 * 同じ判断)。句読点・改行で区切るだけ。話題を持たない相槌文
 * (「よろしくお願いします」等)は、この後 extractIntents が OTHER 単独を
 * 返すため、自然に質問として扱われなくなる。
 */
function splitCustomerQuestions(text: string): string[] {
  return text
    .split(/[。\n！!？?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * UnresolvedFact.field / trustedFactLabel が、どの話題(topic)に関係するかを
 * 判定する。
 *
 * 【設計】新しいキーワード表を作らず、まず intent.ts の extractIntents を
 * そのまま field 文字列に適用する(例: "素材" → MATERIAL、"型番" →
 * PRODUCT_SPEC)。それだけでは拾えない組み合わせだけ、実際に
 * pipeline.ts / shippingIntent.ts / negotiationService.ts が積んでいる
 * 具体的な文言(§既存実装調査で確認したもの)に対する上書きを足す ——
 * 「お届け先の都道府県」は intent.ts の DELIVERY キーワード「お届け」に
 * 一致するが、実際は送料(SHIPPING)を確定できない理由として積まれる事実
 * なので、SHIPPINGにも結びつける。
 */
const FIELD_TOPIC_OVERRIDES: { pattern: RegExp; topics: InquiryIntent[] }[] = [
  // "配送先"はconversationContext.tsのknownFacts()が使うラベル、
  // "お届け先"はshippingIntent.ts/negotiationService.tsが使うラベル。
  // どちらも送料を確定できるかどうかの話なのでSHIPPINGへ結び付ける。
  { pattern: /お届け先|配送先|外形寸法|ShippingRate|送料/, topics: ["SHIPPING"] },
  { pattern: /販売状況/, topics: ["STOCK"] },
  { pattern: /販売価格/, topics: ["PRICE"] },
];

function fieldTopics(field: string): InquiryIntent[] {
  const base = extractIntents(field).filter((t) => t !== "OTHER");
  const overrides = FIELD_TOPIC_OVERRIDES.filter((o) => o.pattern.test(field)).flatMap((o) => o.topics);
  return [...new Set([...base, ...overrides])];
}

function relatedLabels(topic: InquiryIntent, labels: string[]): string[] {
  return labels.filter((l) => fieldTopics(l).includes(topic));
}

/**
 * 「矛盾」を示す未解決事実か。
 *
 * pipeline.ts の型番食い違い検出(detectModelNumberMismatch)は、
 * 「一致しません」「食い違っている可能性」という文言で理由を書く
 * (2026-09-10 追加指示§2)。新しく矛盾判定をやり直さず、その理由文を
 * 目印にする —— 判定そのものは既存のdetectModelNumberMismatchに任せ、
 * ここでは「それが矛盾由来の未解決だ」と読み分けるだけ。
 */
const CONFLICT_MARKERS = ["食い違", "一致しません", "矛盾"];

function isConflictReason(reason: string): boolean {
  return CONFLICT_MARKERS.some((m) => reason.includes(m));
}

const PRODUCT_NOT_IDENTIFIED_CONSTRAINT =
  "対象商品が特定できていません。この項目は断定せず、確認のうえ改めてご案内する旨を自然な言葉で伝える。";
const CONFLICT_CONSTRAINT =
  "商品の記載とお客様の情報が食い違っています。どちらが正しいかを断定せず、現物を確認のうえ改めてご案内する旨を伝える。";
const ALREADY_KNOWN_CONSTRAINT = "この項目はすでに会話で分かっています。改めて尋ねず、分かっている前提で答える。";

function needsCheckConstraint(fields: string[]): string {
  return `この項目は確認できていません(${fields.join("、")})。断定せず、確認のうえ改めてご案内する旨を伝える。`;
}

/**
 * 質問1件分のAnswerPlanItemを組み立てる。
 *
 * 優先順位:
 *   1. この話題が商品に依存する質問なのに、商品が特定できていない
 *      → NEEDS_CHECK (intent.tsのrequiresProductをそのまま再利用)
 *   2. この話題に関係する未解決事実の中に「矛盾」がある
 *      → CONFLICT (現物確認へ誘導。断定しない)
 *   3. この話題に関係する未解決事実がある(矛盾ではない)
 *      → NEEDS_CHECK (未知の一項目だけを保留にし、他の話題は止めない)
 *   4. それ以外
 *      → ANSWERABLE (根拠(evidenceRefs)は分かっている範囲で添える。
 *         根拠が1件も無くても、既存のunresolved判定で「分からない」に
 *         挙がっていない以上、営業時間・返品条件のようにナレッジ/
 *         返信ルールで答えられる話題として扱う —— unresolvedの判定を
 *         ここで重複判定しない)
 */
function buildItem(questionId: string, topic: InquiryIntent, params: BuildAnswerPlanParams): AnswerPlanItem {
  if (!params.hasProduct && requiresProduct([topic])) {
    return {
      questionId,
      topic,
      status: "NEEDS_CHECK",
      evidenceRefs: [],
      answerConstraints: [PRODUCT_NOT_IDENTIFIED_CONSTRAINT],
    };
  }

  const related = params.unresolved.filter((u) => fieldTopics(u.field).includes(topic));
  const conflict = related.find((u) => isConflictReason(u.reason));
  const trustedForTopic = relatedLabels(topic, params.trustedFactLabels);

  if (conflict) {
    return { questionId, topic, status: "CONFLICT", evidenceRefs: [], answerConstraints: [CONFLICT_CONSTRAINT] };
  }

  if (related.length > 0) {
    // 未知の一項目のせいで話題全体を保留にしない(§4)。同じ話題に
    // 既に分かっている周辺情報があれば、根拠として残す(部分回答)。
    return {
      questionId,
      topic,
      status: "NEEDS_CHECK",
      evidenceRefs: trustedForTopic,
      answerConstraints: [needsCheckConstraint(related.map((u) => u.field))],
    };
  }

  const known = relatedLabels(topic, params.knownFactLabels);
  return {
    questionId,
    topic,
    status: "ANSWERABLE",
    evidenceRefs: [...trustedForTopic, ...known],
    answerConstraints: known.length > 0 ? [ALREADY_KNOWN_CONSTRAINT] : [],
  };
}

/**
 * 質問単位のAnswerPlanを組み立てる。
 *
 * 同じ話題(topic)が本文中に複数回現れても、AnswerPlanItem(根拠・制約を
 * 持つ側)は1項目にまとめる ——「サイズは何cmですか、あと高さも知りたい
 * です」を2項目に分けても、どちらも同じ根拠(サイズ)で答えるため実益が
 * 無く、生成後検査で二重にMISSING/COVEREDを数えるほうが誤解を招く。
 *
 * 一方で questionCount(件数)は重複除去**しない**。件数は
 * buildAnswerPlanGuidance が「質問は実質1件です」と断定するかどうかに
 * 直結しており、話題の重複除去をそのまま件数へ持ち込むと、座面幅と高さの
 * ように**同じ話題の複数質問**が「1件」に丸められ、実際には答えるべき
 * 質問が複数あるのに「簡潔に1件だけ答えればよい」という誤った指示文を
 * 生んでしまう(実測の指摘)。
 */
export function buildAnswerPlan(params: BuildAnswerPlanParams): AnswerPlan {
  const segments = splitCustomerQuestions(params.messageText);
  const items: AnswerPlanItem[] = [];
  const seen = new Set<InquiryIntent>();
  let counter = 0;
  let questionCount = 0;
  for (const segment of segments) {
    const topics = extractIntents(segment).filter((t) => t !== "OTHER");
    questionCount += topics.length;
    for (const topic of topics) {
      if (seen.has(topic)) continue;
      seen.add(topic);
      counter += 1;
      items.push(buildItem(`Q${counter}`, topic, params));
    }
  }
  return { items, questionCount };
}

/* ══════════════════════════════════════════════════════════════════
 * 生成後の検査(§7 生成された返信文とAnswerPlanを照合する)
 * ══════════════════════════════════════════════════════════════════ */

export type AnswerPlanCoverage = "MISSING" | "UNVERIFIED";

export interface AnswerPlanCoverageItem {
  questionId: string;
  topic: InquiryIntent;
  planStatus: AnswerPlanStatus;
  coverage: AnswerPlanCoverage;
}

export interface AnswerPlanInspectionResult {
  items: AnswerPlanCoverageItem[];
  /** MISSINGが1件以上あるか(=答え漏れの疑いが強い)。 */
  hasLikelyGap: boolean;
}

/**
 * 生成文とAnswerPlanを突き合わせ、話題ごとの言及有無を見る。
 *
 * 【意図的に「COVERED(網羅合格)」を返さない】この関数が持てる根拠は
 * 「生成文にその話題のキーワードが出てくるか」だけで、値まで正しく
 * 答えられているかまでは確認できない。キーワードが**無い**ことは
 * 「答えていない」のかなり強い根拠になる(MISSING)が、**ある**ことは
 * 「正しく答えた」の根拠にはならない(UNVERIFIED)。検査不能な場合に
 * 「網羅合格」だと判定しないという要件を、型のレベルで満たす
 * ——呼び出し側がCOVEREDという値を受け取る経路がそもそも無い。
 */
export function inspectAnswerPlanCoverage(output: string, plan: AnswerPlan): AnswerPlanInspectionResult {
  const outputTopics = new Set(extractIntents(output ?? ""));
  const items: AnswerPlanCoverageItem[] = plan.items.map((item) => ({
    questionId: item.questionId,
    topic: item.topic,
    planStatus: item.status,
    coverage: outputTopics.has(item.topic) ? "UNVERIFIED" : "MISSING",
  }));
  return { items, hasLikelyGap: items.some((i) => i.coverage === "MISSING") };
}

/**
 * 根拠(evidenceRefs)の無い約束を書いていないか(§9)。
 *
 * 写真追加・発送日確定・値引き・清掃・状態の程度は、在庫DB
 * (CUSTOMER_SAFE_INVENTORY_FIELDS)に対応する項目が無く、AnswerPlanが
 * evidenceRefsとして持てることが構造的に無い。断定した時点で根拠が
 * 無いと分かるので、AnswerPlanの内容を見なくても検出できる
 * (値引きだけは値下げ交渉で確定額を提示する正規の経路があるため、
 * 呼び出し側が`groundedDiscount`でその旨を伝えられるようにする。
 * **`groundedDiscount`は「値引き承認の確定事実があるか」だけを表す
 * ものとして呼び出し側が渡すこと** —— 単に「顧客が金額を書いた」
 * 「送料が確定した」というだけでは値引きの根拠にならない。呼び出し側
 * (pipeline.ts)では negotiationService が実際に計算した値引き後価格の
 * 有無で判定している)。
 *
 * 【状態の程度だけは在庫DBに根拠を持てる】"状態の程度の断定"は他の4件と
 * 違い、`facts.conditionDisclosure`(在庫のdamageNotes等由来。
 * CUSTOMER_SAFE_INVENTORY_FIELDSの「状態」)という**構造的な根拠**を
 * 持ちうる。この事実が既にtrustedProductFactsに載っている状態で、
 * 生成文がその内容をそのまま述べただけでも(例:
 * facts.conditionDisclosureが「傷、汚れはほとんどございません」で、
 * 生成文がそれをそのまま書いた場合)、このパターンは無条件に反応して
 * しまう —— 根拠のある回答を「根拠なし」と誤判定し、既存の再試行枠
 * (REPLY_MAX_GENERATION_ATTEMPTS)を消費し続ける("§8 完了条件: 根拠ある
 * 状態の回答を一律に根拠なしとして再生成し続けない")。値引きと同じ
 * 形で`groundedCondition`を受け取り、呼び出し側(pipeline.ts)が
 * trustedProductFacts に「状態」ラベルの事実があるときだけ渡す。
 * 写真追加・発送日確定・清掃には対応する在庫DB項目が無いため、
 * 同種のgrounded判定を作らない(§9の要件どおり無条件のまま)。
 */
const UNGROUNDED_PROMISE_PATTERNS: { label: string; re: RegExp; discount?: boolean; condition?: boolean }[] = [
  { label: "写真の追加送付", re: /(?:追加|別角度|もう少し|他)[^。\n]{0,10}(?:写真|画像|お写真)[^。\n]{0,6}(?:お送り|ご送付|送付|アップ)(?:いたし|し)(?:ます|ました)/ },
  { label: "発送日の確定", re: /(?:\d{1,2}月\d{1,2}日|明日|今週中|来週中|必ず)[^。\n]{0,10}(?:発送|出荷)(?:いたし|し)ます/ },
  { label: "値引き", re: /(?:お値引き|値引き|割引)(?:いたし|させていただき|し)ます/, discount: true },
  { label: "清掃", re: /(?:清掃|クリーニング)(?:いたし|し)(?:ます|てから)/ },
  { label: "状態の程度の断定", re: /(?:状態|傷|汚れ)[^。\n]{0,10}(?:ほとんど|一切)?(?:ございません|良好です|きれいです)/, condition: true },
];

export function detectUngroundedPromises(
  output: string,
  options?: { groundedDiscount?: boolean; groundedCondition?: boolean },
): string[] {
  const text = output ?? "";
  const found: string[] = [];
  for (const p of UNGROUNDED_PROMISE_PATTERNS) {
    if (p.discount && options?.groundedDiscount) continue;
    if (p.condition && options?.groundedCondition) continue;
    if (p.re.test(text)) found.push(p.label);
  }
  return found;
}

/**
 * 内部の計画・スコア等の用語が、顧客向けの生成文にそのまま漏れていないか
 * (§11)。通常はプロンプト(prompt.ts)側で防ぐが、AIが指示を守らなかった
 * 場合の最後の砦として機械的に検査する。
 */
const INTERNAL_TERMS = [
  "AnswerPlan",
  "ANSWERABLE",
  "NEEDS_CHECK",
  "questionId",
  "evidenceRefs",
  "answerConstraints",
  "confidence",
  "スコア",
];

export function detectInternalLeak(output: string): string[] {
  const text = output ?? "";
  return INTERNAL_TERMS.filter((t) => text.includes(t));
}

/* ══════════════════════════════════════════════════════════════════
 * プロンプトへ足す分量制御(§8 短い単一質問には長文を出さない)
 * ══════════════════════════════════════════════════════════════════ */

/**
 * AnswerPlanの件数から、生成量の指示文を組み立てる。
 *
 * **件数は plan.questionCount を使う(plan.items.length ではない)。**
 * items は話題(topic)ごとに重複除去済みなので、その長さを件数として
 * 使うと、同じ話題への複数質問(座面幅と高さ等)が「1件」に丸められ、
 * 「質問は実質1件です」という誤った断定を生む。questionCount は
 * buildAnswerPlan が重複除去する前に数えているため、この丸めを含まない。
 *
 * prompt.tsのbuildInquiryUserPromptへそのまま1セクションとして渡す
 * (呼び出し側の追加は「渡す」だけで、生成ロジックそのものはAIに委ねる ——
 * 新しい分類AI呼び出しは増やさない)。
 */
export function buildAnswerPlanGuidance(plan: AnswerPlan): string | null {
  const count = plan.questionCount;
  if (count === 0) return null;
  const lines: string[] = [];
  if (count <= 1) {
    lines.push("お客様の質問は実質1件です。その1件に直接答える範囲で簡潔に書く。関係の無い項目まで書き足して長文にしない。");
  } else {
    lines.push(
      `お客様の質問はおおよそ${count}件です。それぞれに漏れなく具体的に答える。1件を長々と説明するより、` +
        "各質問に的確に答えることを優先する。",
    );
  }
  if (plan.items.some((i) => i.status === "CONFLICT")) {
    lines.push(
      "記載とお客様の情報が食い違っている項目は、一致する・しないと断定せず、現物を確認のうえ改めてご案内する旨を伝える。",
    );
  }
  if (plan.items.some((i) => i.status === "NEEDS_CHECK") && plan.items.some((i) => i.status === "ANSWERABLE")) {
    lines.push("答えられる項目は答えたうえで、確認が必要な項目だけを保留にする(すべてを保留にしない)。");
  }
  return lines.join("\n");
}
