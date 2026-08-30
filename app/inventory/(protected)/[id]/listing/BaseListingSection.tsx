"use client";

import { useEffect, useState } from "react";
import { getBaseChannelListingAction, isBaseConnectedAction, listOnBaseAction, saveBaseChannelOverrideAction } from "@/app/actions/listing";
import type { ChannelListingRecord } from "@/lib/listing/types";

const STATUS_LABEL: Record<ChannelListingRecord["status"], string> = {
  NOT_PREPARED: "未準備", DRAFT: "下書き", READY: "準備完了", QUEUED: "キュー待ち",
  PUBLISHING: "出品処理中", ACTIVE: "出品中", PAUSED: "一時停止", SOLD: "売却済み",
  ENDED: "終了", RELIST_PENDING: "再出品待ち", ERROR: "エラー", ARCHIVED: "アーカイブ",
};

/**
 * BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASE
 * (thebase.in)への出品セクション。ListingForm.tsxのMercariセクションと
 * 並列に置く — 1つのInventoryが複数チャネル(Mercari/BASE)へ独立して
 * 出品できることをUIでも体現する。
 *
 * Mercariと違いカテゴリーマッピング・送料負担者・コンディション選択が
 * 必須ではない(BASE items/add APIの必須パラメータがtitle/price程度と
 * 確認できたため) — 出品下書き(ListingDraft)のタイトル・説明文・価格を
 * そのままBASEへ送る、シンプルな1ボタン出品。
 */
export function BaseListingSection({ inventoryId, hasDraft }: { inventoryId: string; hasDraft: boolean }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [channelListing, setChannelListing] = useState<ChannelListingRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isBaseConnectedAction().then(setConnected).catch(() => setConnected(false));
    getBaseChannelListingAction(inventoryId).then(setChannelListing).catch(() => setChannelListing(null));
  }, [inventoryId]);

  async function handleListOnBase() {
    setBusy(true);
    setError(null);
    try {
      if (!channelListing) {
        await saveBaseChannelOverrideAction(inventoryId, { categoryMapping: null, overrideTitle: null, overrideDescription: null, overridePrice: null });
      }
      const result = await listOnBaseAction(inventoryId);
      setChannelListing(result);
      if (result.status === "ERROR" && result.lastError) setError(result.lastError);
    } catch (err) {
      setError(err instanceof Error ? err.message : "出品に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <p className="mb-2 text-[13px] font-bold text-gray-900">BASEへ出品</p>
      {connected === false && (
        <p className="text-[12px] text-gray-400">
          BASEに接続されていません。<a href="/admin/settings" className="text-blue-700 underline">管理画面の設定</a>から接続してください。
        </p>
      )}
      {connected && (
        <>
          {channelListing && (
            <dl className="mb-2 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
              <dt className="text-gray-500">状態</dt>
              <dd className="col-span-3">{STATUS_LABEL[channelListing.status]}</dd>
              {channelListing.externalListingId && (
                <>
                  <dt className="text-gray-500">BASE商品ID</dt>
                  <dd className="col-span-3 font-mono">{channelListing.externalListingId}</dd>
                </>
              )}
              {channelListing.lastError && (
                <>
                  <dt className="text-gray-500">前回エラー</dt>
                  <dd className="col-span-3 text-red-600">{channelListing.lastError}</dd>
                </>
              )}
            </dl>
          )}
          <button
            type="button"
            onClick={handleListOnBase}
            disabled={!hasDraft || busy || channelListing?.status === "ACTIVE"}
            className="border border-gray-900 px-3 py-1.5 text-[12px] font-bold text-gray-900 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? "出品処理中…" : channelListing?.status === "ACTIVE" ? "出品済みです" : "BASEに出品する"}
          </button>
          {!hasDraft && <p className="mt-1 text-[11px] text-gray-400">先に出品下書き（タイトル・説明文・価格）を保存してください。</p>}
          <p className="mt-1 text-[11px] text-gray-400">画像はBASE側にはまだ自動同期されません（テキスト情報のみ出品されます）。</p>
        </>
      )}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
