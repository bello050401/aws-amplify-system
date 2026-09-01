/**
 * §8 ナレッジ検索。純粋関数のみ。
 *
 * 【なぜベクトルDBを新設しないか】§8が明示的に禁じている。文書数が
 * 数十件の規模では、タイトル・カテゴリ・説明・本文へのキーワード一致で
 * 十分に上位を取れる。埋め込みモデルと専用ストアを足すと、コスト・
 * 障害点・「なぜこの文書が選ばれたか説明できない」という3つの問題を
 * 同時に抱えることになる。
 *
 * 【禁止事項の実装】「全ナレッジ文書を毎回無条件にLLMへ投げない」は、
 * このファイルが**関連する部分だけを切り出す**ことで担保する。
 * selectSnippet()が本文全体ではなくヒット箇所の周辺だけを返す。
 */
import { KNOWLEDGE_CONTEXT_MAX_CHARS, KNOWLEDGE_MAX_DOCUMENTS, KNOWLEDGE_SNIPPET_MAX_CHARS } from "./limits";

export interface SearchableKnowledgeDocument {
  id: string;
  title: string;
  originalFileName: string;
  description: string | null;
  category: string | null;
  searchText: string | null;
  isActive: boolean;
  aiReferenceEnabled: boolean;
}

export interface KnowledgeHit {
  document: SearchableKnowledgeDocument;
  score: number;
  /** ヒットした語(管理画面に「なぜこの文書が選ばれたか」を出すため)。 */
  matchedTerms: string[];
  /** AIへ渡す抜粋。本文全体ではない。 */
  snippet: string;
}

/** 場所によって重みを変える。タイトルの一致は本文の一致より強い手がかり。 */
const WEIGHT_TITLE = 5;
const WEIGHT_CATEGORY = 3;
const WEIGHT_DESCRIPTION = 2;
const WEIGHT_BODY = 1;

/**
 * 検索キーワードを問い合わせ本文から作る。
 *
 * 助詞や定型句を除いた2文字以上の語。references.tsの
 * extractProductNameFragmentsと似ているが、あちらは「商品名の断片」を
 * 探すのに対しこちらは「文書を引く語」を探す —— 「営業時間」「住所」の
 * ような、商品名には出てこないが文書には出てくる語を落としてはいけない
 * ので、別の関数として持つ。
 */
const QUERY_STOP_WORDS = new Set([
  "ください", "お願い", "いたし", "ます", "です", "ました", "でしょ", "ですか", "ますか",
  "こちら", "この", "その", "あの", "教えて", "いただけ", "について", "して", "する", "ある",
  "よろしく", "お世話", "はじめまして", "こんにちは", "ありがとう",
]);

/**
 * 問い合わせの種別ごとに、文書側で使われがちな語を補う。
 *
 * 【なぜ必要か】「お店はどこにありますか？」という問い合わせには
 * 「住所」「所在地」という語が1つも含まれていない。一方、文書側の見出しは
 * 【所在地】である。語の一致だけを見ていると、この2つは永久に結びつかない
 * —— §24が受入例として挙げる「店舗住所はどこですか → 基本情報.txt」が
 * まさにこの形。
 *
 * 種別はintent.tsが既に決定的に判定しているので、その結果を検索語へ
 * 持ち込む。同義語辞書を別に持つより、判定済みの意図を再利用するほうが
 * 二重管理にならない。
 */
const INTENT_SEARCH_TERMS: Record<string, string[]> = {
  STORE_INFO: ["住所", "所在地", "店舗", "アクセス", "場所"],
  BUSINESS_HOURS: ["営業時間", "営業", "定休", "時間"],
  VISIT: ["来店", "見学", "店舗", "予約"],
  SHIPPING: ["送料", "配送", "家財"],
  DELIVERY: ["配送", "納品", "搬入", "設置"],
  RETURN_POLICY: ["返品", "キャンセル", "保証"],
  NEGOTIATION: ["値引き", "価格"],
};

export function intentSearchTerms(intents: readonly string[]): string[] {
  return [...new Set(intents.flatMap((i) => INTENT_SEARCH_TERMS[i] ?? []))];
}

/**
 * 検索語を作る。
 *
 * 漢字の連続は、そのままの語に加えて2文字ずつの部分列も出す。日本語には
 * 語の切れ目が無いため、「店舗住所」を1語として扱うと「住所」を含む文書に
 * 当たらない。形態素解析器を入れずに済ませるための割り切りで、余計な語が
 * 増える分は重み付け(タイトル>本文)と出現回数の上限で吸収する。
 */
export function buildSearchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9&'\-]{1,29}/g)) terms.push(m[0].toLowerCase());
  for (const m of text.matchAll(/[ァ-ヴー]{2,20}/g)) terms.push(m[0]);
  for (const m of text.matchAll(/[\u4E00-\u9FFF]{2,10}/g)) {
    terms.push(m[0]);
    for (let i = 0; i + 2 <= m[0].length; i++) terms.push(m[0].slice(i, i + 2));
  }
  for (const m of text.matchAll(/[ぁ-ん]{3,8}/g)) terms.push(m[0]);
  return [...new Set(terms.filter((t) => !QUERY_STOP_WORDS.has(t)))];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * ヒット箇所の周辺だけを切り出す。
 *
 * 先頭から固定長で切ると、文書の後半にしかない情報(例: 営業時間が
 * ファイル末尾)が永久にAIへ届かない。ヒット位置を中心に取る。
 */
export function selectSnippet(body: string, terms: string[], maxChars = KNOWLEDGE_SNIPPET_MAX_CHARS): string {
  if (body.length <= maxChars) return body;
  const lower = body.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return body.slice(0, maxChars);
  const start = Math.max(0, best - Math.floor(maxChars / 3));
  const slice = body.slice(start, start + maxChars);
  return (start > 0 ? "…" : "") + slice + (start + maxChars < body.length ? "…" : "");
}

/**
 * 関連する文書だけを選ぶ。
 *
 * aiReferenceEnabledがfalseの文書、isActiveがfalseの文書は最初から
 * 対象外 —— 「AIには参照させたくない」という設定は、検索でヒットさせない
 * ことで守る。
 */
export function retrieveKnowledge(
  documents: SearchableKnowledgeDocument[],
  queryText: string,
  options: { maxDocuments?: number; totalMaxChars?: number; intents?: readonly string[] } = {},
): KnowledgeHit[] {
  const maxDocuments = options.maxDocuments ?? KNOWLEDGE_MAX_DOCUMENTS;
  const totalMaxChars = options.totalMaxChars ?? KNOWLEDGE_CONTEXT_MAX_CHARS;
  const terms = [...new Set([...buildSearchTerms(queryText), ...intentSearchTerms(options.intents ?? [])])];
  if (terms.length === 0) return [];

  const hits: KnowledgeHit[] = [];
  for (const doc of documents) {
    if (!doc.isActive || !doc.aiReferenceEnabled) continue;
    const title = doc.title.toLowerCase();
    const category = (doc.category ?? "").toLowerCase();
    const description = (doc.description ?? "").toLowerCase();
    const body = (doc.searchText ?? "").toLowerCase();

    let score = 0;
    const matchedTerms: string[] = [];
    for (const term of terms) {
      const t = term.toLowerCase();
      let termScore = 0;
      if (title.includes(t)) termScore += WEIGHT_TITLE;
      if (category.includes(t)) termScore += WEIGHT_CATEGORY;
      if (description.includes(t)) termScore += WEIGHT_DESCRIPTION;
      // 本文は出現回数を見るが、長い文書が有利になりすぎないよう3回で頭打ち。
      const bodyHits = Math.min(3, countOccurrences(body, t));
      termScore += bodyHits * WEIGHT_BODY;
      if (termScore > 0) {
        score += termScore;
        matchedTerms.push(term);
      }
    }
    if (score <= 0) continue;
    hits.push({ document: doc, score, matchedTerms, snippet: "" });
  }

  hits.sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title));

  const selected: KnowledgeHit[] = [];
  let used = 0;
  for (const hit of hits.slice(0, maxDocuments)) {
    const remaining = totalMaxChars - used;
    if (remaining <= 200) break;
    const snippet = selectSnippet(hit.document.searchText ?? "", hit.matchedTerms, Math.min(KNOWLEDGE_SNIPPET_MAX_CHARS, remaining));
    used += snippet.length;
    selected.push({ ...hit, snippet });
  }
  return selected;
}
