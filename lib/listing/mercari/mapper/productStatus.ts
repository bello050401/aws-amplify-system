import type { ListingStatus } from "../../types";

/**
 * BELLO統合改修 master指示書 Phase D — origin/claude/
 * mercari-shops-auto-listing-ag0w6m branchのintegrations/mercari-shops/
 * mapper/productStatus.tsから移植。元のProductInternalStatus
 * (PUBLISHED/READY/HIDDEN)をamplify/data/resource.tsのListingStatus
 * (DRAFT/QUEUED/LISTED/FAILED)へ合わせて調整している — 意味的な対応は
 * 「出品実行を試みる/試みた状態はPUBLISHEDを送る」という元の方針を踏襲。
 *
 * [UNVERIFIED] Mercari側の生ステータスはそのままChannelListing.status
 * とは別にexternalListingId/listingUrl等と一緒に保持し、BELLOの内部
 * ステータスと直接同一視しない。
 */
export function internalStatusToMercariApiStatus(status: ListingStatus): string {
  switch (status) {
    case "QUEUED":
    case "LISTED":
      return "PUBLISHED"; // [UNVERIFIED]
    default:
      return "PUBLISHED"; // [UNVERIFIED] 出品実行時は原則PUBLISHEDを送る
  }
}
