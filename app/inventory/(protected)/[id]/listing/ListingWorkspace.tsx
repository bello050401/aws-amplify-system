"use client";

import { useState } from "react";
import Link from "next/link";
import { EC_CHANNEL_LABEL, EC_CHANNELS, type EcChannel } from "@/lib/listing/ecManagement";
import { MercariManualListingPackPanel } from "./MercariManualListingPackPanel";
import { YahooAuctionListingSection } from "./YahooAuctionListingSection";
import { BaseListingEditor } from "./BaseListingEditor";
import { IndependentShopPanel } from "./IndependentShopPanel";
import { MercariShopsLifecycleSection } from "./MercariShopsLifecycleSection";
import type { InventoryDetail } from "@/lib/inventory/queries";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { ChannelListingRecord, ListingDraftRecord, ListingShippingMethod } from "@/lib/listing/types";
import { DEFAULT_LISTING_SHIPPING_METHOD } from "@/lib/listing/types";
import { ListingForm } from "./ListingForm";
import { InventoryFactsPanel } from "./InventoryFactsPanel";
import { ShippingPackageReference } from "./ShippingPackageReference";
import { normalizeShippingPackages } from "@/lib/shipping/packages";
import {commonCategory,commonChannelPrice} from '@/lib/listing/commonSettings';
import { calculateShippingRankFromDimensionsDetailed } from "@/lib/shipping/rank";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";

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
  brandLogoAvailable,
  categoryName,
  statusName,
  images,
  photoAssets,
  initialDraft,
  initialChannelListing,
  canPrepareMercari,
  httpPreparationEligible = false,
}: {
  item: InventoryDetail;
  brandLogoAvailable: boolean;
  categoryName: string | null;
  statusName: string | null;
  images: InventoryImageRecord[];
  photoAssets: WebPhotoAssetView[];
  initialDraft: ListingDraftRecord | null;
  initialChannelListing: ChannelListingRecord | null;
  canPrepareMercari: boolean;
  httpPreparationEligible?: boolean;
}) {
  const initialTab = "COMMON";
  const [tab, setTab] = useState<"COMMON" | "INDEPENDENT" | EcChannel>(initialTab);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([initialTab]));
  const [draft, setDraft] = useState(initialDraft);
  const [dirty, setDirty] = useState(false);
  const [shippingPackages, setShippingPackages] = useState(() => normalizeShippingPackages(initialDraft?.shippingPackages));
  const dimensions = calculateShippingRankFromDimensionsDetailed(item.width, item.depth, item.height);
  const estimatedRank = "rank" in dimensions ? dimensions.rank : null;
  // §1 既定は「らくらく家財便」。保存済みの下書きがあればその選択を復元する。
  const [shippingMethod, setShippingMethod] = useState<ListingShippingMethod>(
    initialDraft?.shippingMethod ?? DEFAULT_LISTING_SHIPPING_METHOD,
  );
  const [goodsPrice, setGoodsPrice] = useState<number | null>(initialDraft?.price ?? null);

  return (
    // 2026-09-04 EC出品改修指示書 §2/§3の2カラム方針はそのまま。
    // 2026-09-10追加指示: 主ECフォームの幅(ListingForm.tsx内部の
    // max-w-2xl/xl:max-w-4xl)は変えない。フォーム側を`xl:w-[56rem]`で
    // その最大幅ぴったりに固定し(以前は`flex-1`で伸びていたぶん、
    // 大画面ではフォーム自身の上限より広い枠を確保しては中身だけ
    // 左詰めで残り、フォームと右パネルの間に死んだ余白ができていた)、
    // 余った分は右パネル側(grow/basis)へ渡す —— 1280pxちょうどでは
    // 従来通りほぼ320px、画面が広がるほど右パネルが余白を吸収する。
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">商品情報の編集</h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">{item.name}</p>
        </div>
        <Link
          href="/inventory/listings"
          onClick={(event) => {
            if (dirty && !window.confirm("保存していない変更があります。変更を破棄して一覧に戻りますか？"))
              event.preventDefault();
          }}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm text-white"
        >
          EC商品一覧へ戻る
        </Link>
      </div>
      <div role="tablist" aria-label="編集する商品情報" className="mb-4 flex gap-1 overflow-x-auto border-b">
        {(["COMMON", ...EC_CHANNELS, ...(canPrepareMercari ? ["INDEPENDENT" as const] : [])] as const).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setVisited((current) => new Set([...current, value]));
            }}
            className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === value ? "border-blue-700 font-bold text-blue-800" : "border-transparent text-gray-500"}`}
          >
            {value === "COMMON" ? "共通の商品情報" : value === "INDEPENDENT" ? "BELLO自社サイト" : EC_CHANNEL_LABEL[value]}
          </button>
        ))}
      </div>
      {dirty && tab !== "COMMON" && (
        <p className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
          共通の商品情報に未保存の変更があります。共通タブで保存してから、販売先の情報を編集してください。
        </p>
      )}
      <div hidden={tab !== "COMMON"}>
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
          <div className="min-w-0 xl:w-[56rem]">
            <ListingForm
              inventoryId={item.id}
              brandLogoAvailable={brandLogoAvailable}
              inventoryName={item.name}
              images={images}
              photoAssets={photoAssets}
              initialDraft={initialDraft}
              initialChannelListing={initialChannelListing}
              canPrepareMercari={canPrepareMercari}
              shippingMethod={shippingMethod}
              onShippingMethodChange={setShippingMethod}
              shippingPackages={shippingPackages}
              onShippingPackagesChange={setShippingPackages}
              estimatedShippingRank={estimatedRank}
              onDraftSaved={saved => { setDraft(saved); setShippingPackages(normalizeShippingPackages(saved.shippingPackages)); }}
              onDirtyChange={setDirty}
              onPriceChange={setGoodsPrice}
            />
          </div>
          <div className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh_-_96px_-_2rem)] xl:grow xl:shrink xl:basis-80 xl:max-w-md xl:overflow-y-auto 2xl:basis-96 2xl:max-w-lg">
            <InventoryFactsPanel
              item={item}
              categoryName={categoryName}
              statusName={statusName}
              shippingMethod={shippingMethod}
            />
            {shippingMethod === "KAZAI" && <ShippingPackageReference
              key={item.id}
              inventoryId={item.id}
              packages={shippingPackages}
              goodsPrice={goodsPrice}
            />}
          </div>
        </div>
      </div>
      {visited.has("MERCARI_SHOPS") && (
        <div hidden={tab !== "MERCARI_SHOPS"}>
          <fieldset disabled={dirty} className="disabled:opacity-50">
            {canPrepareMercari && httpPreparationEligible ? (
              <MercariManualListingPackPanel
                key={draft?.updatedAt??'new'}
                inventoryId={item.id}
                availableQuantity={item.quantity}
                hasDraft={!!draft}
                hasShopsRecord={!!initialChannelListing}
                mode="HTTP"
                commonPrice={draft?commonChannelPrice(draft,'MERCARI_SHOPS'):item.plannedSalePrice}
                commonCategory={commonCategory(draft?.commonCategoryId)?.mercari??null}
                showExecution={false}
              />
            ) : (
              <p className="rounded border bg-gray-50 p-4 text-sm">
                この商品の出品準備には、販売状況と既存の出品情報の確認が必要です。
              </p>
            )}
            <details className="mt-4 rounded-lg border p-4">
              <summary className="cursor-pointer text-sm">CSV・PC連携の補助機能と過去の記録</summary>
              {canPrepareMercari && <Link href={`/inventory/mercari-bridge?inventoryId=${encodeURIComponent(item.id)}`}
                className="my-3 inline-block text-sm text-blue-700 underline">
                既存メルカリShops商品を照合する
              </Link>}
              <MercariShopsLifecycleSection
                inventoryId={item.id}
                listing={initialChannelListing}
                canPrepare={canPrepareMercari}
              />
              <MercariManualListingPackPanel
                inventoryId={item.id}
                availableQuantity={item.quantity}
                hasDraft={!!draft}
                hasShopsRecord={!!initialChannelListing}
                mode="PC"
                showExecution={false}
              />
            </details>
          </fieldset>
        </div>
      )}
      {visited.has("YAHOO") && (
        <div hidden={tab !== "YAHOO"}>
          <fieldset disabled={dirty}>
            <YahooAuctionListingSection key={draft?.updatedAt??'new'} inventoryId={item.id} showExecution={false} />
          </fieldset>
        </div>
      )}
      {visited.has("BASE") && <div hidden={tab!=="BASE"}><fieldset disabled={dirty}><BaseListingEditor inventoryId={item.id} draft={draft}/></fieldset></div>}
      {canPrepareMercari && visited.has("INDEPENDENT") && (
        <div hidden={tab !== "INDEPENDENT"}>
          <fieldset disabled={dirty}>
            <IndependentShopPanel inventoryId={item.id} quantity={item.quantity} />
          </fieldset>
        </div>
      )}
    </div>
  );
}
