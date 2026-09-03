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
  /** この在庫行の数量。統合表示の内訳に使う。 */
  quantity?: number | null;
  /**
   * 同一商品として統合した在庫行(2026-09-03 利用者指示)。
   *
   * BELLOでは同じ商品を傷の有無や在庫数で複数行に分けている
   * (「【小傷あり】…」「【在庫2】…」)。これらは**同じ商品**なので、
   * 候補が割れたと扱わず1件にまとめる。ただし担当者は「どの行が何点か」で
   * 出荷を判断するため、内訳は捨てずにここへ残す。
   *
   * 統合していない(1行だけの)場合は undefined。
   */
  mergedRows?: { inventoryId: string; displayInventoryId: string; name: string; quantity: number | null }[];
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

/**
 * 値下げ交渉の判定結果(管理画面の「参照情報」に出す)。
 * 顧客向け本文へは一切渡さない。
 */
export interface NegotiationEvidence {
  detected: boolean;
  /** そう判断した根拠(「〜になりませんか」「数量 2脚」等)。 */
  signals: string[];
  quantity: number | null;
  requestedTotalPriceYen: number | null;
  requestedUnitPriceYen: number | null;
  /** 今回の本文からではなく、会話の過去の問い合わせから引き継いだか。 */
  carriedOverFromHistory: boolean;
  /** 配送先が未確定のため、値下げ可否より先に地域を確認する段階か。 */
  awaitingDestination: boolean;
}

/**
 * 管理者向けの値下げ判断カード(指示書§6)。
 *
 * **顧客向けの返信本文へは絶対に渡さない。** 仕入価格・販売開始日時・
 * 経過日数を含むため、customer-safe な事実とは型ごと分けてある
 * (lib/inquiry/pipeline.ts は trustedProductFacts と別の変数で扱い、
 *  プロンプト組み立て関数にはこの型を渡す口が無い)。
 */
export interface NegotiationStaffCard {
  productName: string | null;
  baseItemId: string | null;
  baseItemUrl: string | null;
  baseListedPriceYen: number | null;
  inventoryId: string | null;
  displayInventoryId: string | null;
  quantity: number | null;
  /** 現在販売価格(単価)。 */
  unitSalePriceYen: number | null;
  /** 現在販売価格(数量合計)。 */
  totalSalePriceYen: number | null;
  requestedTotalPriceYen: number | null;
  requestedUnitPriceYen: number | null;
  /** 希望値引率(現在価格に対する)。0.12 = 12%。 */
  requestedDiscountRate: number | null;
  /** staff-only。 */
  purchaseUnitPriceYen: number | null;
  /** staff-only。 */
  purchaseTotalPriceYen: number | null;
  /** staff-only。 */
  saleStartDate: string | null;
  /** staff-only。 */
  daysOnSale: number | null;
  shippingRank: string | null;
  /** 送料判定に使った最大外形3辺(表示用)。 */
  shippingDimensionText: string | null;
  shippingSumCm: number | null;
  destinationPrefecture: string | null;
  shippingFeeYen: number | null;
  /** 送料込みの採算情報(現在価格 + 送料)。 */
  totalWithShippingYen: number | null;
  /** 7%値引き基準額(単価)。 */
  baseDiscountedUnitPriceYen: number | null;
  /** 7%値引き後の数量合計。 */
  baseDiscountedTotalPriceYen: number | null;
  /** 希望額との差額(希望額 − 7%値引き後合計)。負なら希望のほうが安い。 */
  differenceFromRequestedYen: number | null;
  /** 公式LINE＋請求書払い条件の適用可否。 */
  officialLinePaymentCondition: { applicable: boolean; reason: string; sourceDocumentTitle: string | null };
  /** AIではなくコードが出した判断理由。 */
  decisionNotes: string[];
  /** 判断に足りていない情報。 */
  missingInformation: string[];
}

/** §33 参照情報。管理画面にだけ出す(顧客へは送らない)。 */
export interface ReplyEvidence {
  product: { inventoryId: string; displayInventoryId: string; name: string; confidence: number } | null;
  /**
   * **在庫(Inventory)の**特定状態。BASE商品の特定状態とは別物。
   *
   * 2026-09-03 利用者指示: 販売中Inventoryが0件でも、BASE商品自体は
   * URLから確実に特定できている。両者を1つの状態に潰すと
   * 「対象商品を特定できませんでした」となり、実際には持っている
   * 商品名・価格・サイズ・配送ランクまで捨ててしまう。
   */
  productStatus: ProductResolutionStatus;
  /**
   * **BASE商品の**特定状態。在庫が見つからなくても RESOLVED になりうる。
   */
  baseProductStatus?: ProductResolutionStatus;
  /**
   * ZAICO同期の未反映が疑われる状態で在庫を拾ったか。
   *
   * 「販売中カテゴリに無い」ことだけを理由に候補を0件にせず、BASE商品名の
   * 強い一致がある場合だけ範囲を広げて拾う。拾ったことは隠さない ——
   * 同期不具合をフォールバックで覆い隠さないため(利用者指示)。
   */
  inventorySyncSuspected?: boolean;
  /** 最後にZAICO同期が完了した時刻。担当者の判断材料。 */
  zaicoLastSyncedAt?: string | null;
  /**
   * 「販売中」カテゴリを解決できたか。false は内部エラーで、
   * 商品が見つからないのとは意味が違う。
   */
  onSaleCategoryResolved?: boolean;
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
  /** URLから特定できたBASE商品。在庫紐付けが未確定でも「どこまで特定できたか」を示す。 */
  baseProducts?: { baseItemId: string; title: string; price: number | null; itemUrl: string | null }[];
  /**
   * 特定できた商品の要点。担当者が対象商品をその場で確認するための情報で、
   * **顧客向けの返信本文には渡らない**（仕入価格・販売開始日時を含むため）。
   */
  identifiedProduct?: IdentifiedProductCard | null;
  /**
   * この返信で実際に適用した返信ルール(§24「使用ルール」)。
   *
   * idとversionを持つのは、後からルールを編集しても**そのとき何が効いて
   * いたか**を追えるようにするため。タイトルだけだと、ルールを直した後で
   * 過去のログを見ても当時の内容が分からない。
   */
  appliedReplyRules?: { id: string; title: string; category: string; version: number }[];
  /** 値下げ交渉の判定結果。 */
  negotiation?: NegotiationEvidence | null;
  /** 管理者向けの値下げ判断カード(顧客本文へは渡らない)。 */
  staffCard?: NegotiationStaffCard | null;
  /** どの生成ルートを通ったか(「参照情報を表示」の診断用)。 */
  generationRoute?: string;
}

/**
 * メッセージ画面に出す「対象商品」カード。
 *
 * ── 顧客向けではない ────────────────────────────────────────────
 *
 * 仕入価格と販売開始日時が入る。値下げ交渉のときにこの2つをすぐ確認
 * したい、という運用要件から来ている。返信本文の組み立て関数へは渡らない
 * 経路にしてあり、既存の NegotiationStaffCard と同じ扱い。
 *
 * ── 「特定できた」ときだけ出す ──────────────────────────────────
 *
 * 商品を一意に特定できていないときは出さない。候補の1つを載せると、
 * 担当者がそれを確定した商品だと思い込む。
 */
export interface IdentifiedProductCard {
  inventoryId: string;
  /** 画面に出す在庫ID(SKU)。 */
  displayInventoryId: string;
  sku: string;
  name: string;
  /** 一覧用サムネイルのstorageKey。無ければnull。 */
  imageKey: string | null;
  salePriceYen: number | null;
  /**
   * salePriceYen がどちらの項目から来たか。画面の見出しを
   * 「販売価格」/「販売予定価格」で出し分けるために持つ。
   */
  salePriceSource: "salePrice" | "plannedSalePrice" | null;
  purchasePriceYen: number | null;
  /** 販売開始日時(ISO)。 */
  saleStartedAt: string | null;
  /** 在庫ステータス名。マスタから引いた表示名。 */
  statusName: string | null;
  quantity: number | null;
  /**
   * 同一商品としてまとめた在庫行の内訳(2026-09-03 利用者指示)。
   *
   * BELLOは同じ商品を傷の有無や在庫数で行に分けている。返信の中身は
   * 1商品として扱ってよいが、**担当者はどの行が何点あるかで出荷を判断する**
   * ので内訳は残す。1行しか無い場合は空配列。
   */
  stockRows: { displayInventoryId: string; name: string; quantity: number | null }[];
  /**
   * 統合した行で値が食い違うため、商品全体の値として使えない項目
   * (2026-09-03 利用者指示)。
   *
   * 傷の有無で分けた行は仕入価格や販売開始日が違うことがある。代表1件の値を
   * 商品全体の値として出すと、担当者はそれを「この商品の原価」と読んでしまう。
   * 食い違う項目は null にしたうえで、ここに項目名を残して理由を示す。
   */
  ambiguousAcrossRows: string[];
  /** 内訳を合計した点数。行が1つなら quantity と同じ。 */
  totalQuantity: number | null;
  /**
   * BASE商品ページ。**この在庫と1対1で結び付いたときだけ**入れる。
   *
   * 問い合わせに商品URLが複数あると、どのURLがこの在庫に対応するかは
   * 照合の途中で失われる(URL群のタイトルをまとめて手がかりにして1件へ
   * 絞るため)。担当者選択・会話紐付けで決まった商品も、URLとは無関係に
   * 決まっている。どちらの場合も、別商品のページへの導線を「この商品の
   * ページ」として見せることになるので null にする。
   */
  baseItemId: string | null;
  baseItemUrl: string | null;
  /**
   * 問い合わせに含まれていたが、このカードと結び付けられなかったBASE商品
   * URLの件数。0でなければ画面で注意を出し、担当者に選び直させる。
   */
  unlinkedBaseProductCount: number;
  /** 何を根拠に特定したか。担当者が信頼度を判断できるようにする。 */
  basis: string;
}

/** §10 送料回答の根拠。金額はすべて既存のShippingRateマスタ由来。 */
export interface ShippingEvidence {
  /** 見積りに使った発送先都道府県。特定できなければnull。 */
  destinationPrefecture: string | null;
  rank: string | null;
  /**
   * rank をどこから得たか(2026-09-03 利用者指示)。
   *
   * BASE_DECLARED(BELLOが商品説明に明記) > STRUCTURED(登録済み) >
   * DIMENSION_INFERRED(寸法からの推定)。担当者が金額の根拠を追えるように
   * 保持する —— 同じ「Cランク」でも、明記されたものと推定したものでは
   * 確認すべきことが違う。
   */
  rankSource?: import("@/lib/shipping/rank").ShippingRankSource | null;
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
  /**
   * これまでの会話で確定した情報(2026-09-03 追加指示 §17-§25)。
   *
   * **history とは役割が違う。** history は文章の並びで、読み直せば
   * だいたい分かる、という程度のもの。こちらは「どの商品か」「いくらの
   * 希望か」「いま何を尋ねて待っているか」を構造として確定させたもので、
   * 短い後続メッセージ(「埼玉です」)でも失われない。
   *
   * 未指定なら空の文脈として扱う —— この機能の前に作られた会話や、
   * 画面からの単発の再生成でも動く必要がある。
   */
  context?: import("./conversationContext").ConversationContext | null;
  /**
   * 商品特定にだけ使う追加テキスト。**顧客本文とは別扱いにする。**
   *
   * メルカリShopsの通知メールのように、顧客の文面とは別に商品名・商品URLが
   * メタ情報として届く経路のためのもの。これを messageText へ混ぜると、
   * AIが「顧客が商品URLを送ってきた」と読み、「お送りいただいたURLの
   * 商品ですが」のような事実でない前置きを書く。特定にだけ使い、
   * プロンプトへは渡さない。
   */
  productLookupText?: string | null;
  /**
   * 顧客本文とは別に、**事実として**AIへ渡す前提。
   *
   * メルカリShopsの取引メッセージのように、「購入済みの注文に対する
   * やり取りである」という文脈がメール側のメタ情報として届く場合に使う。
   * 顧客本文へ混ぜると、AIがそれを顧客の発言として読んでしまう。
   */
  additionalContext?: string | null;
  /**
   * 販売チャネル側の正式な商品名(§4)。商品URLが無いチャネル
   * (メルカリShopsのメール)で、出品タイトルをそのまま照合へ渡すために使う。
   */
  productTitle?: string | null;
}
