import type { ListingStatus } from "../../types";

/**
 * BELLO統合改修 master指示書 Phase D — origin/claude/
 * mercari-shops-auto-listing-ag0w6m branchのintegrations/mercari-shops/
 * mapper/productStatus.tsから移植。元のProductInternalStatus
 * (PUBLISHED/READY/HIDDEN)をamplify/data/resource.tsのListingStatus
 * へ合わせて調整している — 意味的な対応は「出品実行を試みる/試みた
 * 状態はPUBLISHEDを送る」という元の方針を踏襲。
 *
 * BELLO統合業務OS指示書(2026-08-30) §14でListingStatusが12値へ拡張
 * された後も、この関数の呼び出し元(lib/listing/mercari/adapter.tsの
 * createMercariProduct)は常に`status: "PUBLISHING"`のタイミングでしか
 * 呼ばれない(lib/listing/service.tsのlistOnMercari参照) —
 * 呼び出し時点のstatusがどの値であっても常にPUBLISHEDを送る、という
 * 実際の呼び出しパターンに合わせ、あえてswitchではなく単純な定数関数
 * のままにしている(switchで全12値を列挙しても意味的な情報が増えない
 * ため — §124「過剰設計防止」)。
 *
 * [UNVERIFIED] Mercari側の生ステータスはそのままChannelListing.status
 * とは別にexternalListingId/listingUrl等と一緒に保持し、BELLOの内部
 * ステータスと直接同一視しない。
 */
export function internalStatusToMercariApiStatus(status: ListingStatus): string {
  // 呼び出しパターン上は常に"PUBLISHING"だが、将来の拡張(§21相当の
  // 状態別分岐)に備えて引数自体は残し、switchの形も維持する。
  switch (status) {
    default:
      return "PUBLISHED"; // [UNVERIFIED] 出品実行時は原則PUBLISHEDを送る
  }
}
