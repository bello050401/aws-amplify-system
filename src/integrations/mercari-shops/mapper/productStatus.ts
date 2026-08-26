import type { ProductInternalStatus } from "@prisma/client";

/**
 * 自社内部ステータス (ProductInternalStatus) と、Mercari出品時に送信するAPI Status
 * [UNVERIFIED] を対応付ける。Mercari側の生ステータスはそのまま
 * `MercariListing.mercariStatus` に保持し、内部ステータスと直接同一視しない
 * （指示書31, 58項）。
 */
export function internalStatusToMercariApiStatus(status: ProductInternalStatus): string {
  switch (status) {
    case "PUBLISHED":
    case "READY":
      return "PUBLISHED"; // [UNVERIFIED]
    case "HIDDEN":
      return "PRIVATE"; // [UNVERIFIED]
    default:
      return "PUBLISHED"; // [UNVERIFIED] 出品実行時は原則PUBLISHEDを送る
  }
}
