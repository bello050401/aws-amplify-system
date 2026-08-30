import type { ShippingRank } from "./rank";

/**
 * BELLO統合業務OS指示書(2026-08-30) §65 — ShippingRate(家財おまかせ便
 * 料金マスタ)の共有型。amplify/data/resource.tsのShippingRate model /
 * ShippingRank enumと1対1(他のlib/listing/typesと同じ「Amplify Data
 * のenumは独立したランタイム型を生成しないため呼び出し側で複製する」
 * パターン)。
 */
export interface ShippingRateRecord {
  id: string;
  provider: string; // 例: "アートセッティングデリバリー"
  service: string; // 例: "家財おまかせ便"
  originPrefecture: string; // 常に"埼玉県"(§61) — それでもDBに持たせておくのは、将来複数拠点になった場合に備えるため
  originArea: string | null; // 地域細分(例: "地域Ⅳ" — §66調査では実際の地域区分表までは確認できなかったため現状常にnull)
  destinationPrefecture: string;
  destinationArea: string | null;
  rank: ShippingRank;
  // 第六ラウンド§9/§84: サービス対象外(status="UNAVAILABLE")の組合せは
  // 0円ではなくnullで表す — 「配送不可/要確認」の表示はこのnullを見る。
  price: number | null;
  taxIncluded: boolean; // 第六ラウンド§10追加。既存データ(この項目導入以前)はtrue扱いで読む(既存の税込前提を変えない)
  currency: string; // 第六ラウンド§10追加。既定"JPY"
  surcharge: number | null; // 繁忙期加算等(§66調査で存在は確認済み、金額は未確認)
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceReference: string | null; // 出典(URL・検索日等)
  acquiredAt: string | null; // 第六ラウンド§10追加。importerが実際に取得した日時(verifiedAtとは別概念)
  verifiedAt: string | null;
  status: "VERIFIED" | "UNAVAILABLE" | "STALE" | "UNCONFIRMED" | null; // 第六ラウンド§10追加。null=この項目導入以前の手動投入行
  rawHash: string | null; // 第六ラウンド§10追加
  importBatchId: string | null; // 第六ラウンド§10追加
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
