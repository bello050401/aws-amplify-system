import "server-only";
import { SecretsManagerClient, GetSecretValueCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { buildResearchCacheKey, isResearchCacheFresh } from "./cache";
import { compareBySourcePriority, downgradeIfUncertain, evaluateModelEvidence, type ResearchProvider, type ResearchProviderResult, type ResearchQuery, type ResearchSourceDocument } from "./port";
import { htmlToText, sanitizeExternalText } from "./sanitize";
import type { ExternalResearchFact, ExternalSourceType } from "../types";

/**
 * §9 外部Webリサーチの実行層。
 *
 * 【今、実際にできること・できないこと】
 *  - できる: 問い合わせ本文にURLが含まれている場合、そのページを取得して
 *    事実を抽出する(認証情報が不要なため)。メーカー公式ページのURLを
 *    顧客が貼ってくるケースはそのまま扱える。
 *  - できない: 検索エンジンからの探索。Web検索APIの認証情報がBELLOに
 *    まだ無い。**動くふりはしない** —— NOT_CONFIGUREDという状態を返し、
 *    UIには「Web検索は未設定」と出す(§19「成功したふりを禁止」)。
 *
 * 認証情報を Secrets Manager の `bello/web-research` に
 * `{"provider":"brave","apiKey":"..."}` の形で入れれば、コードを変えずに
 * 検索が有効になる。値は一切ログに出さない。
 */

const SECRET_NAME = "bello/web-research";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;

export type WebResearchAvailability =
  | { available: false; reason: string }
  | { available: true; providerId: string };

interface WebResearchSecret {
  provider?: string;
  apiKey?: string;
}

let secretCache: { at: number; value: WebResearchSecret | null } | null = null;
const SECRET_TTL_MS = 5 * 60 * 1000;

async function loadSecret(): Promise<WebResearchSecret | null> {
  if (secretCache && Date.now() - secretCache.at < SECRET_TTL_MS) return secretCache.value;
  let value: WebResearchSecret | null = null;
  try {
    const client = new SecretsManagerClient({ region: REGION });
    const res = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const parsed = JSON.parse(res.SecretString ?? "{}") as WebResearchSecret;
    value = parsed.apiKey ? parsed : null;
  } catch (err) {
    // 「未設定」と「読めなかった」は違う。前者は想定内、後者は権限や
    // ネットワークの問題なので警告として残す(値は出さない)。
    if (!(err instanceof ResourceNotFoundException)) {
      console.warn("[webResearch] Secretを読めませんでした(未設定として扱います)", { name: SECRET_NAME, error: err instanceof Error ? err.name : "unknown" });
    }
    value = null;
  }
  secretCache = { at: Date.now(), value };
  return value;
}

export async function getWebResearchAvailability(): Promise<WebResearchAvailability> {
  const secret = await loadSecret();
  if (!secret) {
    return {
      available: false,
      reason: "Web検索APIの認証情報が未設定です(AWS Secrets Manager: bello/web-research)。問い合わせ本文にURLがある場合のみ、そのページを直接参照します。",
    };
  }
  return { available: true, providerId: secret.provider ?? "unknown" };
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

async function fetchPage(url: string): Promise<ResearchSourceDocument | null> {
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
    const sanitized = sanitizeExternalText(htmlToText(raw));
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
  modelHints: string[];
  providers: ResearchProvider[];
  /** 同一ページを項目ごとに取り直さないため、取得済みの本文を渡せる。 */
  now?: number;
}): Promise<ResearchOutcome> {
  if (params.fields.length === 0) {
    return { attempted: false, facts: [], documentTexts: [], unavailableReason: null };
  }

  const facts: ExternalResearchFact[] = [];
  const documentTexts: string[] = [];
  const unavailableReasons: string[] = [];
  let attempted = false;

  for (const field of params.fields) {
    const queryText = [...params.modelHints, field].filter(Boolean).join(" ");
    const cacheKey = buildResearchCacheKey({ inventoryId: params.inventoryId, field, queryText });
    const cached = await readCache(cacheKey, field, params.now);
    if (cached) {
      facts.push(cached);
      continue;
    }

    let documents: ResearchSourceDocument[] = [];
    for (const provider of params.providers) {
      const result = await provider.fetchDocuments({ field, queryText, modelHints: params.modelHints });
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
export function extractFieldValue(text: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return null;
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
  const { errors } = await serverDataClient.models.ExternalResearchCache.update(payload, inventoryAuthMode);
  if (errors) {
    const { errors: createErrors } = await serverDataClient.models.ExternalResearchCache.create(payload, inventoryAuthMode);
    if (createErrors) {
      // キャッシュに書けなくても調査結果自体は使える。落とさず警告に留める。
      console.warn("[webResearch] キャッシュの書き込みに失敗しました", { cacheKey, error: createErrors[0]?.message });
    }
  }
}
