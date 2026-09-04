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
import { AutoPricingSection } from "./AutoPricingSection";
import { ShippingEstimateSection } from "./ShippingEstimateSection";
import { ShippingReferencePriceSection } from "./ShippingReferencePriceSection";
import { BaseListingSection } from "./BaseListingSection";
import { generateListingCopyAction } from "@/app/actions/ai";
import { InventoryImageGallery } from "../../../InventoryImageGallery";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";

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
  images,
  initialDraft,
  initialChannelListing,
  mercariConnected,
}: {
  inventoryId: string;
  inventoryName: string;
  /** 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §9: Inventory Masterの商品画像(トップ画像が先頭に来るよう呼び出し元でソート済み) — このコンポーネント自体は画像データを一切書き込まず、表示のみ。 */
  images: InventoryImageRecord[];
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
  const [aiBusy, setAiBusy] = useState(false);
  /**
   * 生成の品質情報(2026-09-02 指示書§2/§10)。
   *
   * どのStyle Profile版を使い、どの過去BASE商品を参考にし、検査で何が
   * 引っかかったかを担当者へ出す。「生成しました」だけでは、寸法が
   * 混ざったのか事実を作ったのかが分からない。
   */
  const [aiQuality, setAiQuality] = useState<{
    violations: string[];
    missingFacts: string[];
    styleProfileVersion: number | null;
    referencedBaseItemIds: string[];
    completionNotes: string[];
    savedId: string | null;
    introSanitized: boolean;
    /** §21 データ不足の警告(座面寸法が無い・配送ランクを確定できない等)。 */
    warnings: string[];
    /** どのメンテナンス文・状態文をどの根拠で入れたか。 */
    ruleNotes: string[];
    /** ルールで確定した配送判定。送料計算と突き合わせられるように出す(§8)。 */
    shipping: { kazaiRank: string | null; kazaiSumCm: number | null; sagawaSize: string | null; sagawaNote: string };
  } | null>(null);

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

  /**
   * BELLO統合業務OS指示書(2026-08-30) §56/§59: 生成結果はタイトル/
   * 説明文欄へ反映するだけ — 「保存」は別ボタン(handleSaveDraft)で
   * ユーザーが明示的に行う。§89: このボタンを押すまでAI requestは
   * 発生しない。
   *
   * 第六ラウンドP0-1: generateListingCopyActionはもう例外をthrowせず
   * `{ok, ...}`を返す(app/actions/ai.tsのコメント参照——production
   * buildでNext.js自身がServer Actionのthrowメッセージを問答無用で
   * マスクする実挙動を実機再現した上での根本修正)。ここでのtry/catch
   * は「Server Actionそのものの呼び出しが失敗する」極めて稀なケース
   * (ネットワーク切断等)だけを拾う——業務エラーはもう例外経路を通らない。
   */
  /**
   * §22 人が編集した説明文を、AI再生成で黙って消さない。
   *
   * これまでは無条件で上書きしていた。長文の商品説明を手直しした直後に
   * 生成ボタンを押すと、その編集が取り返しなく消える(下書きを保存する
   * 前なら復元手段が無い)。**最後に画面へ入れた文面と違う**ときだけ
   * 確認する —— 生成直後にもう一度押す場合や、未編集の下書きを作り直す
   * 場合は、確認を挟まない(毎回聞くと惰性で「はい」を押すようになる)。
   */
  const [lastAppliedDescription, setLastAppliedDescription] = useState(initialDraft?.description ?? "");

  async function handleGenerateWithAi() {
    if (description.trim() && description !== lastAppliedDescription) {
      const ok = window.confirm(
        "説明文を編集されています。AIで生成し直すと、この内容は置き換えられます。よろしいですか？",
      );
      if (!ok) return;
    }
    setAiBusy(true);
    setDraftError(null);
    setAiQuality(null);
    try {
      const result = await generateListingCopyAction(inventoryId);
      if (!result.ok) {
        setDraftError(result.error);
        return;
      }
      setTitle(result.data.title);
      // 2026-09-02: 本文は正本エンジンが作ったセクション付きの完成形を
      // そのまま使う。以前はここで箇条書きと【コンディション】を継ぎ足して
      // いたが、いまは description に「◎商品のご紹介 / ◎サイズ /
      // ◎コンディション / ◎発送について」が既に入っているので、
      // 足すと二重になる。
      setDescription(result.data.description);
      setLastAppliedDescription(result.data.description);
      setAiQuality({
        violations: result.violations,
        missingFacts: result.missingFacts,
        styleProfileVersion: result.styleProfileVersion,
        referencedBaseItemIds: result.referencedBaseItemIds,
        completionNotes: result.completionNotes,
        savedId: result.savedId,
        introSanitized: result.introSanitized,
        warnings: result.warnings,
        ruleNotes: result.ruleNotes,
        shipping: result.shipping,
      });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "AI生成に失敗しました。");
    } finally {
      setAiBusy(false);
    }
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
    // 2026-09-04 EC出品改修指示書 §2: PC(xl以上)では右パネルと2カラムに
    // なるので、フォーム側の上限を広げる。max-w-2xl(672px)のままだと
    // フォームと右パネルの間に300px以上の死んだ余白が残り、
    // 「画面の左半分しか使っていない」という元の問題が形を変えて残る。
    // 広げすぎると1行が長くなって読みにくいので 4xl(896px)で止める。
    <div className="max-w-2xl xl:max-w-4xl">
      <p className="mb-4 text-[12px] text-gray-500">
        「{inventoryName}」をECチャネルへ出品するための下書き・設定です。Inventory本体（在庫マスタ）のデータは一切変更されません。
      </p>

      {/* 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §9: 在庫詳細
          ページと同一のInventoryImageGallery(メイン画像+複数画像の
          閲覧手段+ライトボックス+No Imageプレースホルダーを標準装備)を
          そのまま再利用する——画像を複製せず、既存のthumbnail/S3/
          signed URLアーキテクチャに乗る。 */}
      <div className="mb-4">
        <InventoryImageGallery images={images} alt={inventoryName} title="商品画像" />
      </div>

      {!mercariConnected && (
        <div className="mb-4 border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-800">
          Mercari Shops API TOKENが未設定です。下書きの作成・カテゴリー設定は行えますが、「Mercariに出品」は接続設定（設定画面 → EC出品（Mercari）タブ）の完了後に使用できます。
        </div>
      )}

      {/* 出品下書き(Common Listing Draft) — チャネルに依存しない共通項目。 */}
      <div className="border border-gray-200 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12px] font-bold text-gray-700">出品下書き（共通項目）</p>
          <button
            type="button"
            onClick={handleGenerateWithAi}
            disabled={aiBusy}
            className="border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="在庫の事実情報からタイトル・説明文の下書きを生成します（生成結果は編集・保存前提です）"
          >
            {aiBusy ? "生成中…" : "AIで下書きを生成"}
          </button>
        </div>
        {/* §21 データ不足は生成を止めずに知らせる。「⚠ 座面寸法が登録されて
            いません」「⚠ 配送ランクを確定できません」がここに出る。 */}
        {aiQuality && aiQuality.warnings.length > 0 && (
          <div className="mb-2 border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
            <p className="font-bold">確認が必要な項目</p>
            <ul className="mt-1">
              {aiQuality.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {aiQuality && (
          <div className="mb-2 border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-600">
            <p className="font-bold text-gray-700">生成の内訳（担当者向け）</p>
            {/* §8 送料計算と商品説明で判定が食い違っていないかを、その場で
                見比べられるようにする(どちらも lib/shipping/rank.ts の
                同じ関数を通しているが、見えないと確かめようが無い)。 */}
            <p>
              配送判定: 家財おまかせ便{aiQuality.shipping.kazaiRank ?? "（未確定）"}
              {aiQuality.shipping.kazaiRank ? "ランク" : ""}
              {aiQuality.shipping.kazaiSumCm != null ? `（3辺合計${aiQuality.shipping.kazaiSumCm}cm）` : ""}
              {" ／ 佐川: "}
              {aiQuality.shipping.sagawaSize ?? "（判定不可）"}
            </p>
            <p className="text-gray-400">{aiQuality.shipping.sagawaNote}</p>
            {aiQuality.ruleNotes.length > 0 && (
              <ul className="mt-1">
                {aiQuality.ruleNotes.map((n, i) => (
                  <li key={i}>・{n}</li>
                ))}
              </ul>
            )}
            <p>
              文体プロファイル: {aiQuality.styleProfileVersion != null ? `v${aiQuality.styleProfileVersion}` : "未設定"} ／ 参考にした過去BASE商品:{" "}
              {aiQuality.referencedBaseItemIds.length}件
            </p>
            {aiQuality.introSanitized && (
              <p className="text-amber-700">「◎商品のご紹介」に寸法が含まれていたため、該当の文を自動で取り除きました。</p>
            )}
            {aiQuality.completionNotes.length > 0 && (
              <ul className="mt-1">
                {aiQuality.completionNotes.map((n, i) => (
                  <li key={i}>・{n}</li>
                ))}
              </ul>
            )}
            {aiQuality.missingFacts.length > 0 && (
              <p>在庫にもBASEにも情報が無いため空欄のまま: {aiQuality.missingFacts.join("、")}</p>
            )}
            {aiQuality.violations.length > 0 ? (
              <ul className="mt-1 border border-amber-300 bg-amber-50 p-1 text-amber-800">
                {aiQuality.violations.map((v, i) => (
                  <li key={i}>・{v}</li>
                ))}
              </ul>
            ) : (
              <p className="text-gray-500">品質検査: 問題は見つかりませんでした。</p>
            )}
          </div>
        )}
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
            {/* label と textarea を id で結び付ける。以前は結び付いておらず、
                支援技術からもE2Eからも「説明文」という名前で辿れなかった。 */}
            <label htmlFor="listing-description" className="block text-[12px] text-gray-600">
              説明文
            </label>
            {/* 2026-09-04 EC出品改修指示書 §1-1: 初期高さを約4倍(4行→16行)。
                リサイズ機能はそのまま残す —— `resize-y` を明示するのは、
                Tailwindのpreflightに任せると将来 `resize-none` を足した
                誰かが気づかずに機能を消せてしまうため。横方向は固定
                (`resize-y`)にして、右パネルとの2カラムレイアウトを
                ユーザー操作で壊せないようにする。 */}
            <textarea
              id="listing-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={16}
              className="mt-0.5 w-full resize-y border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
            />
            <p className="mt-0.5 text-right text-[11px] text-gray-400">{description.length.toLocaleString("ja-JP")}文字</p>
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

      {/* BELLO統合業務OS指示書(2026-08-30) §18/§161: 自動値下げは商品
          ごとの明示的なオプトインで、既定はOFF。ChannelListingが存在
          する(=Mercari個別設定を保存済み)商品にだけ表示する。 */}
      {channelListing && <AutoPricingSection inventoryId={inventoryId} channelListing={channelListing} onUpdated={setChannelListing} />}

      {/* BELLO統合業務OS指示書(2026-08-30) §67-68: 送料見積り(家財おまかせ便)。
          AutoPricingSectionと同じ理由でChannelListing存在時のみ表示する。 */}
      {channelListing && <ShippingEstimateSection inventoryId={inventoryId} channelListing={channelListing} onUpdated={setChannelListing} />}

      {/* BELLO統合業務OS ZAICO級高速化・完成保証最大化版(2026-08-30) §31/§46:
          送料込み参考価格。ShippingEstimateSectionと違いChannelListing
          の有無に依存しない(出品準備前でも販売予定金額・寸法さえあれば
          表示できる読み取り専用の目安)。 */}
      <ShippingReferencePriceSection inventoryId={inventoryId} />

      {/* BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASEを
          「別システムだから」と対象外にせず、Mercariと並列のチャネルと
          して扱う。draftの有無だけを条件にする(BASEはMercariと違い
          カテゴリーマッピング等の事前設定が必須ではないため)。 */}
      <BaseListingSection inventoryId={inventoryId} hasDraft={Boolean(draft)} />
    </div>
  );
}
