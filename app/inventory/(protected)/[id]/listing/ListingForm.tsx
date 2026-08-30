"use client";

import { useEffect, useState } from "react";
import {
  getChannelListingAction,
  getListingDraftAction,
  listMercariCategoriesAction,
  listOnMercariAction,
  saveChannelOverrideAction,
  saveListingDraftAction,
} from "@/app/actions/listing";
import type { ChannelListingRecord, ListingConditionCode, ListingDraftRecord, ShippingPayerCode } from "@/lib/listing/types";
import { LISTING_CONDITIONS } from "@/lib/listing/mercari/mapper/condition";
import { SHIPPING_PAYERS } from "@/lib/listing/mercari/mapper/shippingPayer";

// BELLO統合業務OS指示書(2026-08-30) §14: Listing Status State Machine
// 12値(app/inventory/(protected)/listings/ListingsOverviewTable.tsxの
// STATUS_LABELと同じ日本語ラベル方針)。
const STATUS_LABEL: Record<ChannelListingRecord["status"], string> = {
  NOT_PREPARED: "未準備",
  DRAFT: "下書き",
  READY: "出品準備完了",
  QUEUED: "出品待ち",
  PUBLISHING: "出品処理中…",
  ACTIVE: "出品済み",
  PAUSED: "停止中",
  SOLD: "売却済み",
  ENDED: "終了",
  RELIST_PENDING: "再出品待ち",
  ERROR: "出品失敗",
  ARCHIVED: "アーカイブ済み",
};

/**
 * BELLO統合改修 master指示書 Phase D — EC出品(Mercari Shops)の編集/
 * 実行UI。3つの独立した保存単位(下書き/チャネル設定/実出品)を持つ —
 * どれもInventory本体の在庫データを一切変更しない(READ ONLY境界)。
 * Mercari未接続(TOKEN未設定)でも下書き作成・カテゴリーマッピング入力
 * 自体は行える(spec: 「認証情報が未設定の場合、そこだけを
 * BLOCKED_BY_USERにする」) — 「Mercariに出品」ボタンだけが未接続時に
 * 無効化される。
 */
export function ListingForm({
  inventoryId,
  inventoryName,
  initialDraft,
  initialChannelListing,
  mercariConnected,
}: {
  inventoryId: string;
  inventoryName: string;
  initialDraft: ListingDraftRecord | null;
  initialChannelListing: ChannelListingRecord | null;
  mercariConnected: boolean;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [channelListing, setChannelListing] = useState(initialChannelListing);

  const [title, setTitle] = useState(initialDraft?.title ?? inventoryName);
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [price, setPrice] = useState(initialDraft?.price != null ? String(initialDraft.price) : "");
  const [condition, setCondition] = useState<ListingConditionCode>(initialDraft?.condition ?? "NO_NOTABLE_DAMAGE");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);

  const [categoryId, setCategoryId] = useState(initialChannelListing?.categoryMapping?.mercariCategoryId ?? "");
  const [categoryName, setCategoryName] = useState(initialChannelListing?.categoryMapping?.mercariCategoryName ?? "");
  const [overrideTitle, setOverrideTitle] = useState(initialChannelListing?.overrideTitle ?? "");
  const [overrideDescription, setOverrideDescription] = useState(initialChannelListing?.overrideDescription ?? "");
  const [overridePrice, setOverridePrice] = useState(initialChannelListing?.overridePrice != null ? String(initialChannelListing.overridePrice) : "");
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelSaved, setChannelSaved] = useState(false);

  const [shippingPayer, setShippingPayer] = useState<ShippingPayerCode>("SELLER");
  const [listing, setListing] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);

  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  useEffect(() => {
    if (!mercariConnected) return;
    setCategoriesLoading(true);
    listMercariCategoriesAction()
      .then((cats) => setCategories(cats.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCategories([]))
      .finally(() => setCategoriesLoading(false));
  }, [mercariConnected]);

  async function refreshStatus() {
    const [d, c] = await Promise.all([getListingDraftAction(inventoryId), getChannelListingAction(inventoryId)]);
    setDraft(d);
    setChannelListing(c);
  }

  async function handleSaveDraft() {
    setDraftError(null);
    setDraftSaved(false);
    if (!title.trim()) {
      setDraftError("出品タイトルを入力してください。");
      return;
    }
    setDraftBusy(true);
    try {
      const result = await saveListingDraftAction(inventoryId, {
        title,
        description,
        price: price ? Number(price) : 0,
        condition,
      });
      setDraft(result);
      setDraftSaved(true);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "下書きの保存に失敗しました。");
    } finally {
      setDraftBusy(false);
    }
  }

  async function handleSaveChannelOverride() {
    setChannelError(null);
    setChannelSaved(false);
    if (!draft) {
      setChannelError("先に出品下書きを保存してください。");
      return;
    }
    if (!categoryId.trim()) {
      setChannelError("Mercariのカテゴリー（末端カテゴリー）を選択してください。");
      return;
    }
    setChannelBusy(true);
    try {
      const result = await saveChannelOverrideAction(inventoryId, {
        categoryMapping: { mercariCategoryId: categoryId.trim(), mercariCategoryName: categoryName.trim() || undefined },
        overrideTitle: overrideTitle.trim() || null,
        overrideDescription: overrideDescription.trim() || null,
        overridePrice: overridePrice ? Number(overridePrice) : null,
      });
      setChannelListing(result);
      setChannelSaved(true);
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : "チャネル設定の保存に失敗しました。");
    } finally {
      setChannelBusy(false);
    }
  }

  async function handleListOnMercari() {
    setListingError(null);
    setListing(true);
    try {
      const result = await listOnMercariAction(inventoryId, shippingPayer);
      setChannelListing(result);
      if (result.status === "ERROR") setListingError(result.lastError ?? "出品に失敗しました。");
    } catch (err) {
      setListingError(err instanceof Error ? err.message : "出品に失敗しました。");
      await refreshStatus();
    } finally {
      setListing(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        「{inventoryName}」をECチャネルへ出品するための下書き・設定です。Inventory本体（在庫マスタ）のデータは一切変更されません。
      </p>

      {!mercariConnected && (
        <div className="mb-4 border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-800">
          Mercari Shops API TOKENが未設定です。下書きの作成・カテゴリー設定は行えますが、「Mercariに出品」は接続設定（設定画面 → EC出品（Mercari）タブ）の完了後に使用できます。
        </div>
      )}

      {/* 出品下書き(Common Listing Draft) — チャネルに依存しない共通項目。 */}
      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">出品下書き（共通項目）</p>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="block text-[12px] text-gray-600">
              出品タイトル <span className="text-red-500">*</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[12px] text-gray-600">説明文</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] text-gray-600">価格（円）</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-gray-600">コンディション</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as ListingConditionCode)}
                className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              >
                {LISTING_CONDITIONS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {draft && draft.images.length === 0 && (
          <p className="mt-2 text-[11px] text-amber-700">在庫に商品画像が登録されていません。出品には少なくとも1枚の商品画像が必要です。</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={draftBusy}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {draftBusy ? "保存中…" : "下書きを保存"}
          </button>
          {draftSaved && <span className="text-[12px] text-green-700">保存しました</span>}
        </div>
        {draftError && <p className="mt-2 text-[12px] text-red-600">{draftError}</p>}
      </div>

      {/* チャネル別設定(Channel Listing + Channel Override) — Mercari固有のカテゴリーマッピングと、共通下書きを上書きしたい項目だけ入力する。 */}
      <div className="mt-4 border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">Mercari Shops 個別設定</p>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="block text-[12px] text-gray-600">
              Mercariカテゴリー <span className="text-red-500">*</span>
            </label>
            {mercariConnected && categories.length > 0 ? (
              <select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setCategoryName(categories.find((c) => c.id === e.target.value)?.name ?? "");
                }}
                className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              >
                <option value="">未選択</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  placeholder="カテゴリーID"
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  {mercariConnected
                    ? categoriesLoading
                      ? "カテゴリー一覧を取得中…"
                      : "カテゴリー一覧を取得できませんでした。カテゴリーIDを直接入力してください。"
                    : "Mercari接続後は選択肢から選べるようになります。"}
                </p>
              </>
            )}
          </div>
          <details className="text-[12px] text-gray-600">
            <summary className="cursor-pointer text-[11px] font-bold text-gray-400">共通下書きを上書き（任意）</summary>
            <div className="mt-2 grid grid-cols-1 gap-3">
              <div>
                <label className="block text-[12px] text-gray-600">タイトル（Mercari用）</label>
                <input
                  value={overrideTitle}
                  onChange={(e) => setOverrideTitle(e.target.value)}
                  placeholder="未入力なら共通下書きのタイトルを使用"
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[12px] text-gray-600">説明文（Mercari用）</label>
                <textarea
                  value={overrideDescription}
                  onChange={(e) => setOverrideDescription(e.target.value)}
                  rows={3}
                  placeholder="未入力なら共通下書きの説明文を使用"
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[12px] text-gray-600">価格（Mercari用）</label>
                <input
                  type="number"
                  value={overridePrice}
                  onChange={(e) => setOverridePrice(e.target.value)}
                  placeholder="未入力なら共通下書きの価格を使用"
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
                />
              </div>
            </div>
          </details>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveChannelOverride}
            disabled={channelBusy}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {channelBusy ? "保存中…" : "Mercari設定を保存"}
          </button>
          {channelSaved && <span className="text-[12px] text-green-700">保存しました</span>}
        </div>
        {channelError && <p className="mt-2 text-[12px] text-red-600">{channelError}</p>}
      </div>

      {/* 実出品(External Listing Status)。 */}
      <div className="mt-4 border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">Mercari Shopsへ出品</p>
        <div className="mb-2">
          <label className="block text-[12px] text-gray-600">送料負担</label>
          <select
            value={shippingPayer}
            onChange={(e) => setShippingPayer(e.target.value as ShippingPayerCode)}
            className="mt-0.5 w-56 border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          >
            {SHIPPING_PAYERS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {channelListing && (
          <dl className="mb-3 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
            <dt className="text-gray-500">状態</dt>
            <dd className="col-span-3">{STATUS_LABEL[channelListing.status]}</dd>
            {channelListing.externalListingId && (
              <>
                <dt className="text-gray-500">Mercari商品ID</dt>
                <dd className="col-span-3 font-mono">{channelListing.externalListingId}</dd>
              </>
            )}
            {channelListing.lastError && (
              <>
                <dt className="text-gray-500">最終エラー</dt>
                <dd className="col-span-3 text-red-600">{channelListing.lastError}</dd>
              </>
            )}
          </dl>
        )}

        <button
          type="button"
          onClick={handleListOnMercari}
          disabled={!mercariConnected || listing || !draft || !channelListing || channelListing.status === "ACTIVE"}
          className="border border-gray-900 px-3 py-1 text-[13px] font-bold text-gray-900 disabled:opacity-40"
          title={!mercariConnected ? "Mercari接続（TOKEN設定）が必要です" : undefined}
        >
          {listing ? "出品処理中…" : channelListing?.status === "ACTIVE" ? "出品済みです" : "Mercariに出品する"}
        </button>
        {listingError && <p className="mt-2 text-[12px] text-red-600">{listingError}</p>}
        {!mercariConnected && <p className="mt-2 text-[11px] text-gray-400">Mercari未接続のため出品ボタンは無効化されています。</p>}
      </div>
    </div>
  );
}
