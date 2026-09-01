import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { buildResearchCacheKey, isResearchCacheFresh } from "./cache";
import { compareBySourcePriority, downgradeIfUncertain, evaluateModelEvidence, type ResearchProvider, type ResearchProviderResult, type ResearchQuery, type ResearchSourceDocument } from "./port";
import { htmlToText, sanitizeExternalText } from "./sanitize";
import { escapeRegExp } from "../references";
import type { ExternalResearchFact, ExternalSourceType } from "../types";

/**
 * §9 外部Webリサーチの実行層。
 *
 * 【2つの入口】
 *  - 問い合わせ本文にURLがある場合: そのページを直接取得する
 *    (createDirectUrlProvider)。
 *  - 一般のWeb検索: Amazon Bedrock AgentCore Web Search
 *    (createAgentCoreSearchProvider)。**APIキーは無く**、既存のAWS
 *    アカウント内でIAMだけで完結する。
 *
 * どちらも「検索/取得できた」を「事実が分かった」と混同しない。
 * 取得した本文は必ず sanitizeExternalText を通し、型番整合が取れなければ
 * UNCERTAINへ落とし、決定的な抽出に失敗すればNOT_FOUNDのままにする。
 */

const FETCH_TIMEOUT_MS = 10_000;
/** 取得したページ本文の保持上限。仕様表まで届く長さにする(上のコメント参照)。 */
export const RESEARCH_PAGE_TEXT_MAX_CHARS = 24_000;
const MAX_PAGE_BYTES = 1_500_000;

export type WebResearchAvailability =
  | { available: false; reason: string }
  | { available: true; providerId: string };

/**
 * Web検索が使える状態か。
 *
 * 判定材料はGatewayのURLが埋まっているかどうかだけ。**APIキーは存在
 * しない**(認可はIAM)ので、秘密値の読み出しも要らない。URLは秘密値では
 * ないが、ビルド時に埋め込む必要がある —— Amplifyの環境変数はSSR
 * ランタイムへ届かないため(next.config.mjsのMERCARI_RELAY_URLと同じ)。
 */
export function getAgentCoreGatewayUrl(): string | null {
  const raw = process.env.AGENTCORE_GATEWAY_URL?.trim();
  return raw ? raw : null;
}

export function getWebResearchAvailability(): WebResearchAvailability {
  const gatewayUrl = getAgentCoreGatewayUrl();
  if (!gatewayUrl) {
    return {
      available: false,
      reason: "Web検索が未設定です(AGENTCORE_GATEWAY_URLが空)。問い合わせ本文にURLがある場合のみ、そのページを直接参照します。",
    };
  }
  return { available: true, providerId: "agentcore-web-search" };
}

/**
 * ホスト名から情報源の種別を推定する(§9 優先順位)。
 *
 * 完全な判定はできない。ここでの目的は「メーカー公式らしきものを
 * 上に持ってくる」ことなので、確信が持てないものはOTHERへ倒す ——
 * OTHERでも使えないわけではなく、順位が下がるだけ。
 */
export function classifySource(url: string, knownBrandHosts: string[] = []): ExternalSourceType {
  let host: string;
  let pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    return "OTHER";
  }
  if (knownBrandHosts.some((h) => host.endsWith(h.toLowerCase()))) return "MANUFACTURER";
  if (/manual|instruction|torisetsu|取扱/.test(pathname)) return "OFFICIAL_MANUAL";
  if (/catalog|catalogue|カタログ/.test(pathname) || pathname.endsWith(".pdf")) return "OFFICIAL_CATALOG";
  // フリマ・オークション・個人ブログは一次情報ではない(§9優先順位の末尾)。
  if (/mercari|yahoo|rakuma|auctions|blog|ameblo|note\.com|hatena/.test(host)) return "OTHER";
  if (/shop|store|ec\./.test(host)) return "AUTHORIZED_RETAILER";
  return "OTHER";
}

/**
 * 問い合わせ本文に含まれるURLを直接取得するProvider。
 *
 * 顧客が貼ったURLだけを見る。任意のURLへ飛び回らない(リダイレクトは
 * fetchの既定に任せるが、取得は1ページのみでリンクを辿らない) ——
 * SSRF的な使われ方をしないよう、入力は「顧客のメッセージにあったURL」に
 * 限定し、内部アドレスは弾く。
 */
export function createDirectUrlProvider(urls: string[]): ResearchProvider {
  return {
    id: "direct-url",
    async fetchDocuments(query: ResearchQuery): Promise<ResearchProviderResult> {
      const targets = urls.filter(isFetchableExternalUrl).slice(0, 3);
      if (targets.length === 0) return { status: "NOT_CONFIGURED", reason: "参照できるURLが問い合わせに含まれていません。" };
      const documents: ResearchSourceDocument[] = [];
      for (const url of targets) {
        const doc = await fetchPage(url);
        if (doc) documents.push(doc);
      }
      if (documents.length === 0) return { status: "ERROR", reason: "URLからページを取得できませんでした。" };
      void query;
      return { status: "OK", documents };
    },
  };
}

/**
 * 内部・ローカルアドレスを弾く。
 *
 * 顧客が貼るURLは信頼できない入力なので、http(s)以外と、
 * ループバック/リンクローカル/プライベートIPを除外する。
 */
export function isFetchableExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  if (host === "::1" || host.startsWith("[")) return false;
  return true;
}

export async function fetchPage(url: string): Promise<ResearchSourceDocument | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "BELLO-InquiryResearch/1.0" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/.test(contentType)) return null;
    const raw = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const title = raw.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim() ?? url;
    // 既定の4,000文字だと、仕様表がページ下部にある商品ページで
    // 「素材」「消費電力」といった項目ごと切り落とされる(実測:
    // artworkstudio.co.jpの製品ページで、ちょうど4,000文字で
    // 途切れて項目名が本文に現れなかった)。この本文はAIへは渡さず、
    // 決定的な抽出と引き写し検査にしか使わないので、広く取ってよい。
    const sanitized = sanitizeExternalText(htmlToText(raw), RESEARCH_PAGE_TEXT_MAX_CHARS);
    return {
      url,
      title: htmlToText(title).slice(0, 200),
      text: sanitized.text,
      sourceType: classifySource(url),
      injectionDetected: sanitized.injectionDetected,
    };
  } catch {
    return null;
  }
}

export interface ResearchOutcome {
  /** 実際に外部へ問い合わせたか。 */
  attempted: boolean;
  facts: ExternalResearchFact[];
  /** 取得した本文(生成文の長文コピー検査に使う。保存はしない)。 */
  documentTexts: string[];
  /** 実行できなかった場合の説明(UIに出す)。 */
  unavailableReason: string | null;
  /**
   * Web検索(課金対象)を実際に呼んだ回数。
   *
   * 在庫DB・ナレッジ・配送DBで答えられる問い合わせでは必ず0になる。
   * 監査情報と構造化ログの両方へ出し、「呼んでいないこと」を後から
   * 確認できるようにする(§21のコスト方針を、主張ではなく計測で示す)。
   */
  searchCallCount: number;
}

/**
 * 不明な項目だけを調べる(§9.1 発動条件)。
 *
 * fieldsが空なら外部へは一切出ない —— 在庫DB・ナレッジ・配送DBで
 * 答えられるなら検索しない、という§21のコスト方針をここで担保する。
 */
export async function researchMissingFacts(params: {
  fields: string[];
  inventoryId: string | null;
  /** 型番・品番のみ。同定に使う。 */
  modelHints: string[];
  /** 検索語を作るためだけの語(ブランド名など)。 */
  brandHints?: string[];
  providers: ResearchProvider[];
  /** Web検索の呼び出し回数(Provider側が数えた値)を読むための関数。 */
  readSearchCallCount?: () => number;
  now?: number;
}): Promise<ResearchOutcome> {
  if (params.fields.length === 0) {
    // ここで返す0が「在庫DB/ナレッジで答えられたのでWeb検索は呼んでいない」
    // ことの証拠になる。
    return { attempted: false, facts: [], documentTexts: [], unavailableReason: null, searchCallCount: 0 };
  }

  const facts: ExternalResearchFact[] = [];
  const documentTexts: string[] = [];
  const unavailableReasons: string[] = [];
  let attempted = false;

  for (const field of params.fields) {
    const brandHints = params.brandHints ?? [];
    const queryText = [...brandHints, ...params.modelHints, field].filter(Boolean).join(" ");
    const cacheKey = buildResearchCacheKey({ inventoryId: params.inventoryId, field, queryText });
    const cached = await readCache(cacheKey, field, params.now);
    if (cached) {
      facts.push(cached);
      continue;
    }

    let documents: ResearchSourceDocument[] = [];
    for (const provider of params.providers) {
      const result = await provider.fetchDocuments({ field, queryText, modelHints: params.modelHints, brandHints });
      if (result.status === "OK") {
        attempted = true;
        documents = documents.concat(result.documents);
      } else {
        unavailableReasons.push(`${provider.id}: ${result.reason}`);
      }
    }
    if (documents.length === 0) {
      facts.push({ field, status: "NOT_FOUND", confidence: 0 });
      continue;
    }

    documents.sort(compareBySourcePriority);
    const best = documents[0];
    documentTexts.push(best.text);

    const evidence = evaluateModelEvidence(best.text, params.modelHints);
    const extracted = extractFieldValue(best.text, field);
    let fact: ExternalResearchFact = extracted
      ? {
          field,
          value: extracted,
          status: "FOUND",
          sourceTitle: best.title,
          sourceUrl: best.url,
          sourceType: best.sourceType,
          confidence: best.sourceType === "MANUFACTURER" ? 0.8 : 0.6,
          modelEvidence: evidence.matched.join(", "),
        }
      : { field, status: "NOT_FOUND", sourceTitle: best.title, sourceUrl: best.url, sourceType: best.sourceType, confidence: 0 };

    // §9.4: 指示文が混ざっていたページは、内容そのものの信頼度も下げる。
    if (best.injectionDetected && fact.status === "FOUND") {
      fact = { ...fact, status: "UNCERTAIN", confidence: Math.min(fact.confidence, 0.3) };
    }
    fact = downgradeIfUncertain(fact, evidence.certain);
    facts.push(fact);
    await writeCache(cacheKey, fact);
  }

  return {
    attempted,
    facts,
    documentTexts,
    unavailableReason: attempted ? null : unavailableReasons.length > 0 ? unavailableReasons.join(" / ") : null,
    searchCallCount: params.readSearchCallCount?.() ?? 0,
  };
}

/**
 * ページ本文から、その項目の値らしき部分を取り出す。
 *
 * 【LLMに抽出させない理由】ここでLLMを挟むと、ページに書いていない値を
 * 「それらしく」返しうる。この機能で最も避けたいのが「外部情報の捏造」
 * なので、抽出は決定的に行い、取れなければNOT_FOUNDとする。取り逃しは
 * 「分からない」として正しく扱われるだけで、害が無い。
 */
/**
 * 抽出時に併せて探す同義語。
 *
 * 顧客は「素材は?」と聞くが、商品ページの仕様表は「材質」と書く ——
 * 実測(artworkstudio.co.jpの製品ページ)でこのずれを確認した。検索語では
 * なく**抽出**の段階の問題なので、ここで吸収する。
 */
const FIELD_SYNONYMS: Record<string, string[]> = {
  素材: ["材質", "本体材質"],
  材質: ["素材", "本体材質"],
  重量: ["重さ", "本体重量", "質量"],
  重さ: ["重量", "本体重量", "質量"],
  消費電力: ["最大消費電力", "定格消費電力"],
  寸法: ["サイズ", "外形寸法"],
  サイズ: ["寸法", "外形寸法"],
  口金: ["電球口金サイズ", "口金サイズ"],
  生産国: ["原産国", "製造国"],
  原産国: ["生産国", "製造国"],
};

export function extractFieldValue(text: string, field: string): string | null {
  for (const candidate of [field, ...(FIELD_SYNONYMS[field] ?? [])]) {
    const value = extractSingleField(text, candidate);
    if (value) return value;
  }
  return null;
}

function extractSingleField(text: string, field: string): string | null {
  // 正規表現のエスケープは references.ts のものを使い回す(同じ処理を
  // 2箇所で持たない)。
  const escaped = escapeRegExp(field);
  const patterns = [
    new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]{1,80})`),
    new RegExp(`${escaped}\\s*(?:は|が)\\s*([^\\n。]{1,60})`),
    new RegExp(`${escaped}[^\\n]{0,10}?([0-9]{1,6}(?:\\.[0-9]+)?\\s*(?:kg|キロ|cm|センチ|mm|W|ワット|V|ボルト|人掛け))`, "i"),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const value = m[1].trim().replace(/[\s]{2,}/g, " ");
      if (value.length >= 1) return value.slice(0, 80);
    }
  }
  return extractFromSpecTable(text, field);
}

/**
 * 仕様表からの抽出。
 *
 * 【なぜ必要か】商品ページの仕様表はHTMLの表で書かれているので、タグを
 * 剥がすと `材質 \n \n \n スチール \n \n \n 重量 \n \n \n 1.2kg` の形になる。
 * コロンも「は」も無いので、上の3パターンでは1つも取れない。実測
 * (artworkstudio.co.jpの製品ページ)でこの形を確認した。
 *
 * 【誤抽出をどう防ぐか】
 *  - ラベルの直後が文字の続きなら別語とみなす。「仕様について」の
 *    「仕様」を拾って「について」を値にしない。
 *  - 値は40文字まで。長い文が続く場合は表の値ではないと判断する。
 *  - 記号だけの行は値にしない。
 * それでも取れなければnull —— 「取れなかった」は不明として正しく扱われる
 * ので、無理に拾うより見送るほうが安全。
 */
/**
 * 同じ量に限定を付けただけの接頭辞。これらが前に付いた場合だけ、ラベルの
 * 部分一致を認める(「最大消費電力」は消費電力の値として正しい)。
 */
/** ラベルの前後がここで切れていれば、独立した項目名とみなす。 */
const LABEL_BOUNDARY = /[\s:：|｜/／]/;

const QUALIFIER_PREFIXES = ["最大", "定格", "本体", "総", "約"];

/** 値ではなく案内・注記の文かどうか。 */
export function isGuidanceText(value: string): boolean {
  if (value.startsWith("※")) return true;
  return /ご覧|ください|下さい|参照|詳しくは|お問い合わせ|準備中|準備中です|-$/.test(value);
}

export function extractFromSpecTable(text: string, field: string): string | null {
  const maxValueLength = 40;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(field, from);
    if (idx < 0) return null;
    from = idx + field.length;

    // ラベルの直後が日本語や英数字なら、それは別の語の一部。
    const next = text[from] ?? "";
    if (next && !LABEL_BOUNDARY.test(next)) continue;

    // 前側も見る。「電球口金サイズ」の末尾の「サイズ」を拾うと、口金の値
    // (E26)を寸法として回答に出してしまう(実測でそうなった)。ただし
    // 「最大消費電力」のように、同じ量に限定を付けただけの接頭辞は認める
    // —— こちらは値として正しい。
    const before = text.slice(Math.max(0, idx - 4), idx);
    const prevChar = before.slice(-1);
    if (prevChar && !LABEL_BOUNDARY.test(prevChar) && !QUALIFIER_PREFIXES.some((q) => before.endsWith(q))) continue;

    const rest = text.slice(from, from + 400);
    const lines = rest.split("\n").map((l) => l.trim());
    const value = lines.find((l) => l.length > 0 && !/^[\s:：|｜/／・\-—─]+$/.test(l));
    if (!value) continue;
    if (value.length > maxValueLength) continue;
    // 「※商品画像を横スクロールして…ご覧ください」のような案内文が、
    // 表の値の位置に入っていることがある(実測)。これを仕様値として
    // 採用すると、顧客への回答に意味の無い文が出る。
    if (isGuidanceText(value)) continue;
    return value.slice(0, 80);
  }
}

async function readCache(cacheKey: string, field: string, now?: number): Promise<ExternalResearchFact | null> {
  try {
    const { data } = await serverDataClient.models.ExternalResearchCache.get({ cacheKey }, inventoryAuthMode);
    if (!data) return null;
    if (!isResearchCacheFresh(data.fetchedAt, field, now)) return null;
    return {
      field: data.field,
      value: data.value ?? undefined,
      status: data.status ?? "NOT_FOUND",
      sourceTitle: data.sourceTitle ?? undefined,
      sourceUrl: data.sourceUrl ?? undefined,
      sourceType: (data.sourceType as ExternalSourceType | null) ?? undefined,
      confidence: data.confidence ?? 0,
    };
  } catch {
    return null;
  }
}

async function writeCache(cacheKey: string, fact: ExternalResearchFact): Promise<void> {
  const payload = {
    cacheKey,
    field: fact.field,
    value: fact.value ?? null,
    status: fact.status,
    sourceTitle: fact.sourceTitle ?? null,
    sourceUrl: fact.sourceUrl ?? null,
    sourceType: fact.sourceType ?? null,
    confidence: fact.confidence,
    fetchedAt: new Date().toISOString(),
  };
  // キャッシュは「次回を速くする」ためだけのもの。ここで失敗しても
  // 調査結果は既に手元にあるので、返信生成を巻き添えにしてはいけない。
  // errorsフィールドだけでなく**例外も**受ける —— 実際、Next.jsの
  // リクエストコンテキスト外(検証スクリプト)ではクライアント自体が
  // 未初期化でTypeErrorになり、返信生成ごと落ちていた。
  try {
    const { errors } = await serverDataClient.models.ExternalResearchCache.update(payload, inventoryAuthMode);
    if (!errors) return;
    const { errors: createErrors } = await serverDataClient.models.ExternalResearchCache.create(payload, inventoryAuthMode);
    if (createErrors) {
      console.warn("[webResearch] キャッシュの書き込みに失敗しました", { cacheKey, error: createErrors[0]?.message });
    }
  } catch (err) {
    console.warn("[webResearch] キャッシュの書き込みで例外", { cacheKey, error: err instanceof Error ? err.name : "unknown" });
  }
}
