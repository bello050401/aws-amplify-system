/**
 * AI問い合わせ返信エンジンの共有型(2026-09-01仕様書 §4/§9/§11/§17/§18/§33)。
 *
 * このファイルは**純粋な型宣言のみ**で、"server-only"を付けない ——
 * 返信案パネル(client component)がそのまま同じ型を使うため。
 * amplify/data/resource.tsのReplyDraftStatus enumとは
 * lib/listing/types.tsと同じ理由で二重定義になる(Amplify Dataのenumは
 * 独立したランタイム型を生成しない)。
 */

/** §11 問い合わせの種別。1つのメッセージが複数持ちうる。 */
export type InquiryIntent =
  | "PRODUCT_SPEC"
  | "PRODUCT_CONDITION"
  | "SIZE"
  | "MATERIAL"
  | "COMPATIBILITY"
  | "STOCK"
  | "PRICE"
  | "SHIPPING"
  | "DELIVERY"
  | "STORE_INFO"
  | "BUSINESS_HOURS"
  | "VISIT"
  | "NEGOTIATION"
  | "RETURN_POLICY"
  | "OTHER";

/** 管理画面に出す日本語ラベル。顧客には出さない。 */
export const INQUIRY_INTENT_LABEL: Record<InquiryIntent, string> = {
  PRODUCT_SPEC: "商品仕様",
  PRODUCT_CONDITION: "商品の状態",
  SIZE: "サイズ",
  MATERIAL: "素材",
  COMPATIBILITY: "適合・組み合わせ",
  STOCK: "在庫",
  PRICE: "価格",
  SHIPPING: "送料",
  DELIVERY: "配送・搬入",
  STORE_INFO: "店舗情報",
  BUSINESS_HOURS: "営業時間",
  VISIT: "来店",
  NEGOTIATION: "価格交渉",
  RETURN_POLICY: "返品・キャンセル",
  OTHER: "その他",
};

/** §4.1 問い合わせ本文から取り出した、商品を指していそうな手がかり。 */
export interface ProductReference {
  urls: string[];
  baseUrls: string[];
  baseItemIds: string[];
  skus: string[];
  inventoryIds: string[];
  modelNumbers: string[];
  brandNames: string[];
  productNameFragments: string[];
}

export type ProductMatchSource = "INVENTORY" | "BASE" | "MESSAGE";

/** §4.2 商品候補1件。confidenceは0〜1。 */
export interface ProductMatch {
  inventoryId: string;
  /** 画面表示用の在庫ID(ZAICO由来ならZAICOの番号、そうでなければSKU)。 */
  displayInventoryId: string;
  sku: string;
  name: string;
  confidence: number;
  /** なぜこの商品だと判断したか。管理画面に出す(顧客には出さない)。 */
  reasons: string[];
  source: ProductMatchSource;
}

/**
 * §4.3 信頼度の境目。
 *
 * 家具は同シリーズ・色違い・サイズ違いが多い(§37)ため、商品名だけの
 * 一致では確定させない —— 名前一致だけで到達できる上限を
 * AUTO_CONFIRM未満に抑えることでこれを保証する(scoring.tsのテスト参照)。
 */
export const PRODUCT_MATCH_AUTO_CONFIRM = 0.95;
export const PRODUCT_MATCH_HIGH_CONFIDENCE = 0.8;
export const PRODUCT_MATCH_CANDIDATE_FLOOR = 0.6;

export type ProductResolutionStatus =
  /** 自動確定できた(confidence >= 0.95、または同点2位と十分な差がある高確度)。 */
  | "RESOLVED"
  /** 候補はあるが人の確認が要る。 */
  | "AMBIGUOUS"
  /** 手がかりがあったが、在庫に該当が無い。 */
  | "NOT_FOUND"
  /** そもそも商品を指す手がかりが無い(営業時間の問い合わせ等)。 */
  | "NOT_REFERENCED";

export interface ProductResolution {
  status: ProductResolutionStatus;
  /** 確定した商品(status === "RESOLVED"のときのみ非null)。 */
  resolved: ProductMatch | null;
  /** 上位候補(confidence降順)。RESOLVEDでも2位以下を残す —— 人が選び直せるようにするため。 */
  candidates: ProductMatch[];
}

/** §3 分からないまま扱う事実。顧客向け文面では自然な表現に変換する。 */
export interface UnresolvedFact {
  /** 何が分からないか(例: "耐荷重", "お届け先の市区町村")。 */
  field: string;
  /** なぜ分からないか(管理画面向け)。 */
  reason: string;
}

export type ExternalSourceType = "MANUFACTURER" | "OFFICIAL_CATALOG" | "OFFICIAL_MANUAL" | "AUTHORIZED_RETAILER" | "OTHER";

export type ExternalResearchStatus = "FOUND" | "NOT_FOUND" | "CONFLICT" | "UNCERTAIN";

/** §9.3 外部調査で得た事実1件。 */
export interface ExternalResearchFact {
  field: string;
  value?: string;
  status: ExternalResearchStatus;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceType?: ExternalSourceType;
  confidence: number;
  /**
   * §38: どのモデルについての事実だと判断したか、その根拠。
   * 同シリーズで年式違いがある場合にこれが空なら不確実として扱う。
   */
  modelEvidence?: string;
}

/** §33 参照情報。管理画面にだけ出す(顧客へは送らない)。 */
export interface ReplyEvidence {
  product: { inventoryId: string; displayInventoryId: string; name: string; confidence: number } | null;
  productStatus: ProductResolutionStatus;
  productCandidates: ProductMatch[];
  /** 在庫DBのどの項目を根拠に使ったか(値ではなく項目名)。 */
  inventoryFieldsUsed: string[];
  knowledgeDocuments: { id: string; title: string; fileName: string }[];
  /** 送料の根拠(既存のらくらく家財DBから引いたもの)。 */
  shipping: ShippingEvidence | null;
  externalResearchAttempted: boolean;
  externalFacts: ExternalResearchFact[];
  /** Web検索(課金対象)を実際に呼んだ回数。在庫DB・ナレッジで答えられた場合は0。 */
  webSearchCallCount?: number;
  unresolvedFacts: UnresolvedFact[];
}

/** §10 送料回答の根拠。金額はすべて既存のShippingRateマスタ由来。 */
export interface ShippingEvidence {
  /** 見積りに使った発送先都道府県。特定できなければnull。 */
  destinationPrefecture: string | null;
  rank: string | null;
  /** 税込の合計(price + surcharge)。マスタに無ければnull。 */
  feeYen: number | null;
  /** 「なぜ金額を出せないのか」の説明(管理画面向け)。 */
  note: string | null;
  /** 顧客に追加で尋ねる必要がある情報。 */
  missingCustomerInfo: string[];
}

export type ReplyDraftStatus =
  | "GENERATING"
  | "READY"
  | "NEEDS_PRODUCT_CONFIRMATION"
  | "NEEDS_CUSTOMER_INFO"
  | "RESEARCH_INCOMPLETE"
  | "FAILED"
  | "USED"
  | "DISMISSED";

export const REPLY_DRAFT_STATUS_LABEL: Record<ReplyDraftStatus, string> = {
  GENERATING: "生成中",
  READY: "作成済み",
  NEEDS_PRODUCT_CONFIRMATION: "対象商品の確認が必要",
  NEEDS_CUSTOMER_INFO: "お客様への確認が必要",
  RESEARCH_INCOMPLETE: "調査で確認できない点あり",
  FAILED: "生成失敗",
  USED: "使用済み",
  DISMISSED: "破棄",
};

/** 画面へ返す返信案1件。ReplyDraftモデルのレコードをそのまま写したもの。 */
export interface ReplyDraftRecord {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  resolvedInventoryId: string | null;
  productMatchConfidence: number | null;
  intents: InquiryIntent[];
  draftText: string | null;
  unresolvedFacts: UnresolvedFact[];
  evidence: ReplyEvidence | null;
  modelProvider: string | null;
  modelName: string | null;
  status: ReplyDraftStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §16 チャネル非依存の入力。LINE専用にしない。 */
export interface InquiryReplyRequest {
  channel: string;
  conversationId: string;
  messageId: string;
  messageText: string;
  /** 会話の直近のやり取り(古い順)。 */
  history: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
  /** 人が候補から選び直した場合の在庫ID。指定されたら自動特定より優先する(§34)。 */
  overrideInventoryId?: string | null;
  /** 会話にあらかじめ紐づいている在庫ID(既存のConversation.relatedInventoryId)。 */
  conversationInventoryId?: string | null;
}
