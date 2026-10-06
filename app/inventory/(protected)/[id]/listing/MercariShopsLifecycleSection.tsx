"use client";

import type { ChannelListingRecord } from "@/lib/listing/types";
import { shopsActionForState, shopsAdminUrl, shopsLifecycle,
  type ShopsOperation } from "@/lib/listing/mercariBridge/listingLifecycle";

const SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const LABEL = {
  NOT_LISTED: "BELLO出品記録なし", CREATING: "出品処理中", LISTED: "出品済み（BELLO記録）",
  STOPPING: "停止処理中", STOPPED: "停止済み（BELLO記録）",
  PRIVATE: "非公開（BELLO記録）", UNKNOWN: "結果の確認が必要",
} as const;

/** Only verified server state may make the action available. The PC executor is not connected yet. */
export function MercariShopsLifecycleSection({ listing, operation = null }: {
  listing: ChannelListingRecord | null;
  operation?: ShopsOperation | null;
}) {
  const state = shopsLifecycle(listing, operation);
  const action = shopsActionForState(state, listing, null);
  const url = listing && state !== "NOT_LISTED" ?
    shopsAdminUrl(SHOP_ID, listing.externalListingId) : null;
  const button = state === "NOT_LISTED" ? "出品" : state === "LISTED" ?
    "出品停止" : state === "STOPPED" ? "再出品" : LABEL[state];
  return <section aria-labelledby="mercari-shops-lifecycle-heading"
    className="mt-4 rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="mercari-shops-lifecycle-heading" className="font-bold">メルカリShops</h2>
      <span className="rounded bg-gray-100 px-2 py-1 text-xs">{LABEL[state]}</span>
    </div>
    {listing?.externalListingId && url && <p className="mt-2 text-xs">
      商品ID: <code>{listing.externalListingId}</code> ／ <a href={url}
        target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">商品管理画面</a>
    </p>}
    <button type="button" disabled={!action} aria-disabled={!action}
      className="mt-3 rounded border border-gray-300 px-3 py-2 text-xs font-bold disabled:opacity-50">
      {button}
    </button>
    <p className="mt-2 text-xs text-gray-600">{state === "UNKNOWN" ?
      "Shops側の結果を確認するまで再操作できません。" :
      state === "CREATING" || state === "STOPPING" ?
        "Shops側の結果を確認中です。重複操作を防ぐため再操作できません。" :
        "BELLOに記録がなくてもShops側に既存商品がある場合があります。画面操作と結果確認を接続するまで、このボタンは実行できません。"}</p>
  </section>;
}
