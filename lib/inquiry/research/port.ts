/**
 * §9 外部Webリサーチの境界。
 *
 * 【なぜ抽象にするか】BELLOには現在、Web検索APIの認証情報が無い。
 * 「検索できないから外部調査機能は作らない」でも「動くふりをする」でも
 * なく、**境界を定義して、未設定であることを状態として返す**。
 * これにより:
 *   - 未設定でも問い合わせ返信は動く(不明点は不明のまま返す)
 *   - 認証情報を入れれば、他を変えずに検索が有効になる
 *   - 検証スクリプトは偽の実装を差し込んで経路をテストできる
 *
 * §19「空の返信」「成功したふり」を禁止 —— NOT_CONFIGUREDは失敗では
 * なく「この手段は使えない」という事実であり、UIにもそう表示する。
 */
import type { ExternalResearchFact, ExternalSourceType } from "../types";

export interface ResearchQuery {
  /** 調べたい項目(例: "耐荷重")。 */
  field: string;
  /** 検索に使う語(メーカー名・型番・商品名などを組み立てたもの)。 */
  queryText: string;
  /** 対象を特定するための情報(§38 年式・シリーズの取り違え防止に使う)。 */
  modelHints: string[];
}

export interface ResearchSourceDocument {
  url: string;
  title: string;
  /** sanitizeExternalText()済みの本文。生のHTMLでも生のテキストでもない。 */
  text: string;
  sourceType: ExternalSourceType;
  /** 取得時にプロンプトインジェクションらしき記述を落としたか。 */
  injectionDetected: boolean;
}

export type ResearchProviderResult =
  | { status: "NOT_CONFIGURED"; reason: string }
  | { status: "ERROR"; reason: string }
  | { status: "OK"; documents: ResearchSourceDocument[] };

/**
 * 外部情報を取ってくる手段。実装は2つ:
 *   - directUrlProvider: 問い合わせに含まれるURLをそのまま取得する(認証不要)
 *   - searchProvider   : 検索APIを使う(認証情報が要る。未設定ならNOT_CONFIGURED)
 */
export interface ResearchProvider {
  readonly id: string;
  fetchDocuments(query: ResearchQuery): Promise<ResearchProviderResult>;
}

/**
 * §9.2 検索語の組み立て。
 *
 * メーカー公式・カタログ・取扱説明書を優先させたいので、検索語自体に
 * それを含める。ここを純粋関数にしてあるのは、検索APIが無い状態でも
 * 「何を調べようとしたか」をテストで固定できるようにするため。
 */
export function buildResearchQueryText(params: { field: string; brand: string | null; modelNumber: string | null; productName: string | null }): string {
  const parts = [params.brand, params.modelNumber, params.productName?.slice(0, 40), params.field].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" ");
}

/**
 * §9 情報源の優先順位。数値が小さいほど優先。
 * メーカー公式 > ブランド公式 > 公式カタログ > 公式取説 > 正規販売店 > その他。
 */
const SOURCE_TYPE_RANK: Record<ExternalSourceType, number> = {
  MANUFACTURER: 0,
  OFFICIAL_CATALOG: 1,
  OFFICIAL_MANUAL: 2,
  AUTHORIZED_RETAILER: 3,
  OTHER: 4,
};

export function compareBySourcePriority(a: { sourceType?: ExternalSourceType }, b: { sourceType?: ExternalSourceType }): number {
  return SOURCE_TYPE_RANK[a.sourceType ?? "OTHER"] - SOURCE_TYPE_RANK[b.sourceType ?? "OTHER"];
}

/**
 * §38 対象モデルの取り違え防止。
 *
 * 取得したページが、いま調べている型番・シリーズについて書かれていると
 * 判断できる根拠があるか。根拠が無ければ、値が書いてあっても
 * UNCERTAINとして扱う —— 「同じシリーズ名の別年式」を正解として
 * 返してしまうのが、この機能で最も起きやすい誤りだから。
 */
export function evaluateModelEvidence(documentText: string, modelHints: string[]): { matched: string[]; certain: boolean } {
  const haystack = documentText.toUpperCase();
  const matched = modelHints.filter((h) => h.trim().length >= 2 && haystack.includes(h.toUpperCase()));
  return { matched, certain: matched.length > 0 };
}

/** 根拠が弱い場合にstatusを引き下げる。 */
export function downgradeIfUncertain(fact: ExternalResearchFact, certain: boolean): ExternalResearchFact {
  if (certain || fact.status !== "FOUND") return fact;
  return { ...fact, status: "UNCERTAIN", confidence: Math.min(fact.confidence, 0.4) };
}
