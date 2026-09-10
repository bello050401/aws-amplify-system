"use client";

import { useState } from "react";
import type { InventoryDetail } from "@/lib/inventory/queries";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { ChannelListingRecord, ListingDraftRecord, ListingShippingMethod } from "@/lib/listing/types";
import { DEFAULT_LISTING_SHIPPING_METHOD } from "@/lib/listing/types";
import { ListingForm } from "./ListingForm";
import { InventoryFactsPanel } from "./InventoryFactsPanel";

/**
 * EC出品画面の2カラムを束ねる(2026-09-10追加指示)。
 *
 * ── なぜこの層が要るのか ──────────────────────────────────────────
 *
 * 配送方法(らくらく家財便／佐川急便)の選択は左のListingForm.tsxにしか
 * UIが無いが、右のInventoryFactsPanel.tsxの座面・配送警告もその選択に
 * 合わせて変わってほしい(切り替えたら即座に反映——両方が別々に状態を
 * 持つと絶対にずれる)。**状態はここ1箇所だけに置き**、両方の子へ
 * 渡す。page.tsx(Server Component)はこの下の2画面をまとめて描画する
 * だけで、状態そのものは持たない。
 */
export function ListingWorkspace({
  item,
  categoryName,
  statusName,
  images,
  initialDraft,
  initialChannelListing,
  mercariConnected,
}: {
  item: InventoryDetail;
  categoryName: string | null;
  statusName: string | null;
  images: InventoryImageRecord[];
  initialDraft: ListingDraftRecord | null;
  initialChannelListing: ChannelListingRecord | null;
  mercariConnected: boolean;
}) {
  // §1 既定は「らくらく家財便」。保存済みの下書きがあればその選択を復元する。
  const [shippingMethod, setShippingMethod] = useState<ListingShippingMethod>(
    initialDraft?.shippingMethod ?? DEFAULT_LISTING_SHIPPING_METHOD,
  );

  return (
    // 2026-09-04 EC出品改修指示書 §2/§3の2カラム方針はそのまま。
    // 2026-09-10追加指示: 主ECフォームの幅(ListingForm.tsx内部の
    // max-w-2xl/xl:max-w-4xl)は変えない。フォーム側を`xl:w-[56rem]`で
    // その最大幅ぴったりに固定し(以前は`flex-1`で伸びていたぶん、
    // 大画面ではフォーム自身の上限より広い枠を確保しては中身だけ
    // 左詰めで残り、フォームと右パネルの間に死んだ余白ができていた)、
    // 余った分は右パネル側(grow/basis)へ渡す —— 1280pxちょうどでは
    // 従来通りほぼ320px、画面が広がるほど右パネルが余白を吸収する。
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="min-w-0 xl:w-[56rem]">
        <ListingForm
          inventoryId={item.id}
          inventoryName={item.name}
          images={images}
          initialDraft={initialDraft}
          initialChannelListing={initialChannelListing}
          mercariConnected={mercariConnected}
          shippingMethod={shippingMethod}
          onShippingMethodChange={setShippingMethod}
        />
      </div>
      <div className="hidden min-w-0 xl:block xl:sticky xl:top-4 xl:max-h-[calc(100vh_-_96px_-_2rem)] xl:grow xl:shrink xl:basis-80 xl:max-w-md xl:overflow-y-auto 2xl:basis-96 2xl:max-w-lg">
        <InventoryFactsPanel item={item} categoryName={categoryName} statusName={statusName} shippingMethod={shippingMethod} />
      </div>
    </div>
  );
}
