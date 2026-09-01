import "server-only";
import { McpSession } from "./mcpClient";
import { classifySource, fetchPage, isFetchableExternalUrl } from "./service";
import { htmlToText, sanitizeExternalText } from "./sanitize";
import { allOfficialDomains } from "./officialDomains";
import type { ResearchProvider, ResearchProviderResult, ResearchQuery, ResearchSourceDocument } from "./port";

/**
 * §9 Amazon Bedrock AgentCore Web Search を使う ResearchProvider。
 *
 * 【なぜこの方式か】BELLOに新しい契約もAPIキーも増やさずに一般Web検索が
 * できる唯一の選択肢だった(Google Custom Searchは新規受付終了、Bingは
 * 廃止済み、Brave/Tavily/Exaはいずれも外部のキー取得が要る)。
 * 呼び出しはIAM(SigV4)で、既存のAWSアカウント内で完結する。
 *
 * 【検索そのものは事実ではない】ここが返すのは「候補のURL」であって、
 * 事実ではない。だからこのProviderは、
 *   検索 → 公式ドメイン優先 → **ページを実際に取得** →
 *   sanitizeExternalText(指示文の除去) → 呼び出し側で型番整合確認 →
 *   決定的な事実抽出
 * という流れの、最初の2段だけを担当する。スニペットをそのまま事実として
 * 採用しない —— スニペットは検索エンジンの要約であって一次情報ではない。
 */

/** 1回の調査で取得するページ数の上限。取りすぎても精度は上がらず、遅くなるだけ。 */
const MAX_PAGES_PER_FIELD = 3;
/** 検索1回あたりの結果件数。 */
const SEARCH_MAX_RESULTS = 8;

export interface AgentCoreSearchResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
}

/**
 * MCPの `tools/call` 応答から検索結果を取り出す。
 *
 * 応答はMCP標準の `content: [{type:"text", text:"<JSON文字列>"}]` で、
 * text の中身がさらにJSON。純粋関数にしてあるのは、AWSへ接続せずに
 * 形を固定できるようにするため(scripts/verify-inquiry.ts)。
 */
export function parseWebSearchResults(toolResult: unknown): AgentCoreSearchResult[] {
  const content = (toolResult as { content?: { type?: string; text?: string }[] })?.content ?? [];
  const results: AgentCoreSearchResult[] = [];
  for (const item of content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text) as { results?: AgentCoreSearchResult[] };
      for (const r of parsed.results ?? []) results.push(r);
    } catch {
      // JSONでないtextは無視する(将来サーバー側が説明文を足しても壊れない)。
    }
  }
  return results;
}

/** Web Searchのクエリ上限は200文字。超えると呼び出し自体が失敗する。 */
export const WEB_SEARCH_QUERY_MAX_CHARS = 200;

export function buildSearchQuery(brandHints: readonly string[], modelHints: readonly string[], field: string): string {
  const query = [...brandHints, ...modelHints, field].filter((v) => v && v.trim().length > 0).join(" ");
  return query.slice(0, WEB_SEARCH_QUERY_MAX_CHARS);
}

export interface AgentCoreProviderOptions {
  gatewayUrl: string;
  /** 公式限定の1回目に使うドメイン。空なら公式限定パスを飛ばす。 */
  officialDomains: string[];
  /** Web検索を1回呼ぶたびに呼ばれる(監査・回数計測用)。 */
  onSearch?: (info: { query: string; scope: "official" | "broad"; resultCount: number }) => void;
}

/**
 * ツール名はGatewayが `<ターゲット名>___<ツール名>` の形で公開する。
 * 定数で持たず tools/list から引くのは、構築スクリプトでターゲット名を
 * 変えたときに静かに壊れないようにするため。
 */
function pickWebSearchTool(tools: { name: string }[]): string | null {
  return tools.find((t) => /websearch$/i.test(t.name))?.name ?? null;
}

export function createAgentCoreSearchProvider(options: AgentCoreProviderOptions): ResearchProvider {
  const session = new McpSession(options.gatewayUrl);
  const officialHosts = allOfficialDomains();

  return {
    id: "agentcore-web-search",
    async fetchDocuments(query: ResearchQuery): Promise<ResearchProviderResult> {
      const searchText = buildSearchQuery(query.brandHints, query.modelHints, query.field);
      if (searchText.trim().length === 0) {
        return { status: "NOT_CONFIGURED", reason: "検索語を組み立てられませんでした(商品を特定できていません)。" };
      }

      let toolName: string;
      try {
        const tools = await session.listTools();
        const picked = pickWebSearchTool(tools);
        if (!picked) return { status: "ERROR", reason: "GatewayにWebSearchツールが公開されていません。" };
        toolName = picked;
      } catch (err) {
        return { status: "ERROR", reason: `Gatewayへ接続できませんでした: ${err instanceof Error ? err.message : String(err)}` };
      }

      const runSearch = async (scope: "official" | "broad"): Promise<AgentCoreSearchResult[]> => {
        const args: Record<string, unknown> = { query: searchText, maxResults: SEARCH_MAX_RESULTS };
        if (scope === "official" && options.officialDomains.length > 0) {
          args.filters = { domainFilter: { include: options.officialDomains } };
        }
        const raw = await session.callTool(toolName, args);
        const results = parseWebSearchResults(raw);
        options.onSearch?.({ query: searchText, scope, resultCount: results.length });
        return results;
      };

      // 1回目: メーカー・ブランド公式に限定する(§9の優先順位)。
      // 2回目: 公式で足りなければ範囲を広げる。ブランドが分からない場合は
      // 1回目を飛ばして、最初から広い検索を1回だけ行う(無駄な課金をしない)。
      let results: AgentCoreSearchResult[] = [];
      try {
        if (options.officialDomains.length > 0) {
          results = await runSearch("official");
        }
        if (results.length === 0) {
          results = await runSearch("broad");
        }
      } catch (err) {
        return { status: "ERROR", reason: `Web検索に失敗しました: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (results.length === 0) {
        return { status: "OK", documents: [] };
      }

      // 公式 → 公式カタログ/取説 → 正規販売店 → その他 の順に並べ替えてから
      // 取得する。取得数を絞るので、この順序がそのまま「何を見るか」になる。
      const ranked = results
        .filter((r) => r.url && isFetchableExternalUrl(r.url))
        .map((r) => ({ result: r, sourceType: classifySource(r.url!, officialHosts) }))
        .sort((a, b) => sourceRank(a.sourceType) - sourceRank(b.sourceType));

      const documents: ResearchSourceDocument[] = [];
      for (const { result, sourceType } of ranked.slice(0, MAX_PAGES_PER_FIELD)) {
        const fetched = await fetchPage(result.url!);
        if (fetched) {
          // classifySourceに公式ドメイン一覧を渡した判定を優先する
          // (fetchPage内の判定はドメイン一覧を知らないため)。
          documents.push({ ...fetched, sourceType, title: fetched.title || result.title || result.url! });
          continue;
        }
        // ページを取得できない場合(PDF・JS依存・403等)は、検索が返した
        // スニペットを使う。**一次情報ではない**ので、これも必ず
        // sanitizeExternalTextを通す。
        const snippet = sanitizeExternalText(htmlToText(result.text ?? ""));
        if (snippet.text.trim().length === 0) continue;
        documents.push({
          url: result.url!,
          title: result.title ?? result.url!,
          text: snippet.text,
          sourceType,
          injectionDetected: snippet.injectionDetected,
        });
      }

      return { status: "OK", documents };
    },
  };
}

function sourceRank(type: ResearchSourceDocument["sourceType"]): number {
  switch (type) {
    case "MANUFACTURER":
      return 0;
    case "OFFICIAL_CATALOG":
      return 1;
    case "OFFICIAL_MANUAL":
      return 2;
    case "AUTHORIZED_RETAILER":
      return 3;
    default:
      return 4;
  }
}
