"use client";

import { useMemo, useState } from "react";
import { saveListingDraftAction } from "@/app/actions/listing";
import type { ChannelListingRecord, ListingConditionCode, ListingDraftRecord, ListingShippingMethod } from "@/lib/listing/types";
import { LISTING_SHIPPING_METHODS } from "@/lib/listing/types";
import { LISTING_CONDITIONS } from "@/lib/listing/conditionOptions";
import { buildManualListingText } from "@/lib/listing/manualListingText";
import { buildShippingWarning, withCurrentShippingWarning } from "@/lib/ai/productPage/listingFacts";
import type { SagawaUnavailableReason } from "@/lib/shipping/sagawaSize";
import { ShippingEstimateSection } from "./ShippingEstimateSection";
import { ShippingReferencePriceSection } from "./ShippingReferencePriceSection";
import { BaseListingSection } from "./BaseListingSection";
import { MercariCategoryMappingSection } from "./MercariCategoryMappingSection";
import { generateListingCopyAction } from "@/app/actions/ai";
import { createBrandedListingImageAction } from "@/app/actions/brandLogo";
import { InventoryImageGallery } from "../../../InventoryImageGallery";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import { setListingPhotoAssetSelectionAction } from "@/app/actions/photoRegistration";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";
import type { ListingImageRef } from "@/lib/listing/types";
import { ListingImageSelector } from "./ListingImageSelector";

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
 * BELLO統合改修 master指示書 Phase D — EC出品の編集UI。
 *
 * Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、このUIから
 * Mercari固有の実行導線(カテゴリーマッピング・送料負担選択・
 * 「Mercariに出品する」ボタン・接続状態バナー)は削除した——理由・
 * 経緯はlib/listing/mercari/adapter.ts冒頭コメント参照。残っているのは
 * どのチャネルにも依存しない共通の下書き編集(タイトル・説明文・価格・
 * コンディション・配送方法・AI生成)で、Inventory本体の在庫データは
 * 一切変更しない(READ ONLY境界)。過去にMercariへ出品した履歴
 * (ChannelListing.status/externalListingId/lastError)は削除しておらず、
 * 下記の読み取り専用表示でそのまま確認できる。
 *
 * 2026-09-14 指示書「Mercariは商品情報・文章・画像の準備と手動出品支援
 * を基本とする」対応。ユーザーの運用ではMercari Shops APIへ実際に
 * 接続できないため、実際の出品は公式のMercari管理画面へ人が手で入力
 * して行う——ここでは準備した下書きの内容を1つのテキストへまとめて
 * clipboardへコピーするだけの「出品内容をコピー」ボタンを用意し、その
 * 入力作業をゼロから行わずに済むようにする(lib/listing/manualListingText.ts、
 * 外部へは何も送信しない)。
 */
export function ListingForm({
  inventoryId,
  inventoryName,
  images,
  photoAssets,
  initialDraft,
  initialChannelListing,
  shippingMethod,
  onShippingMethodChange,
}: {
  inventoryId: string;
  inventoryName: string;
  /** 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §9: Inventory Masterの商品画像(トップ画像が先頭に来るよう呼び出し元でソート済み) — このコンポーネント自体は画像データを一切書き込まず、表示のみ。 */
  images: InventoryImageRecord[];
  photoAssets: WebPhotoAssetView[];
  initialDraft: ListingDraftRecord | null;
  initialChannelListing: ChannelListingRecord | null;
  /**
   * 配送方法(2026-09-10追加指示)。右パネル(InventoryFactsPanel)の
   * 座面・配送警告と同じ選択を共有するため、状態はこのコンポーネントの
   * 外(親のListingWorkspace)へ上げてある —— ここだけで持つと、選択を
   * 変えても右パネルの表示が変わらない(即時反映できない)。
   */
  shippingMethod: ListingShippingMethod;
  onShippingMethodChange: (method: ListingShippingMethod) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [channelListing, setChannelListing] = useState(initialChannelListing);
  const [selectedImages, setSelectedImages] = useState<ListingImageRef[]>(initialDraft?.images ?? []);
  const [brandLogoBusy, setBrandLogoBusy] = useState(false);
  const [brandedImageKey, setBrandedImageKey] = useState<string | null>(null);
  const [brandLogoError, setBrandLogoError] = useState<string | null>(null);

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
    shipping: {
      /** 実際に本文へ入れた配送方法(§1)。画面の選択と一致しているか確かめられる。 */
      method: ListingShippingMethod;
      kazaiRank: string | null;
      /** 家財便ランクを確定できなかった理由。レビュー対応: 生成後に配送方法だけを切り替えたときの警告作り直しに使う。 */
      kazaiRankReason: string | null;
      kazaiSumCm: number | null;
      sagawaSize: string | null;
      /** 佐川サイズを判定できなかった理由。判定できていれば null。 */
      sagawaUnavailableReason: SagawaUnavailableReason | null;
      sagawaNote: string;
    };
  } | null>(null);

  /**
   * §21 データ不足の警告を、生成後に配送方法だけ切り替えても追従させる
   * (レビュー対応: 2026-09-10追加指示)。
   *
   * `aiQuality.warnings` は生成した瞬間の配送方法(`aiQuality.shipping.method`)
   * に対して確定した配列で、以後は固定値のまま — 画面の配送方法セレクトを
   * 切り替えても、これまではその古い配送警告が消えずに残っていた
   * (「らくらく家財便」を選び直しても「佐川急便のサイズを判定できません」
   * が残る)。座面寸法・メンテナンス等、配送に関係ない警告はそのまま
   * 残す(§21 警告を手抜きで全部消さない) —— 配送警告だけを
   * buildShippingWarning で選択中の方法向けに作り直し、
   * withCurrentShippingWarning で差し替える。
   */
  const displayedWarnings = useMemo(() => {
    if (!aiQuality) return [];
    const currentShippingWarning = buildShippingWarning({
      shippingMethod,
      sagawaUnavailableReason: aiQuality.shipping.sagawaUnavailableReason,
      sagawaNote: aiQuality.shipping.sagawaNote,
      shippingRankReason: aiQuality.shipping.kazaiRankReason,
    });
    return withCurrentShippingWarning(aiQuality.warnings, currentShippingWarning);
  }, [aiQuality, shippingMethod]);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  /**
   * 2026-09-14 指示書「Mercariは手動出品支援を基本とする」対応。
   * 準備した内容(タイトル・価格・コンディション・説明文)をMercari公式の
   * 出品画面へ手動で貼り付けられる形にまとめてclipboardへコピーする
   * だけ — 何も送信しない。カテゴリーは、CSV出力向けに復元した
   * MercariCategoryMappingSectionで選択済みならフルパスを含める
   * (未選択ならbuildManualListingText側がセクション自体を出さない)。
   */
  async function handleCopyForManualListing() {
    const text = buildManualListingText({
      title,
      description,
      price: price ? Number(price) : null,
      condition,
      categoryName: channelListing?.categoryMapping?.mercariCategoryName ?? null,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
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
      // §1 画面で選択中の配送方法をそのまま渡す(保存前でも反映する)。
      const result = await generateListingCopyAction(inventoryId, shippingMethod);
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
        // §1 配送方法も一緒に保存する。次に開いたときも、説明文を
        // 再生成したときも同じ選択が使われる。
        shippingMethod,
        images: selectedImages,
      });
      setDraft(result);
      if (photoAssets.length > 0) {
        const photoAssetIds = selectedImages
          .filter((ref): ref is ListingImageRef & { photoAssetId: string } => ref.source === "PHOTO_ASSET" && !!ref.photoAssetId)
          .map((ref) => ref.photoAssetId);
        const selectionResult = await setListingPhotoAssetSelectionAction(inventoryId, {
          listingId: result.id,
          photoAssetIds,
        });
        if (!selectionResult.ok) {
          setDraftError(`下書きは保存されましたが、撮影画像の選択情報の更新に失敗しました: ${selectionResult.message}`);
          return;
        }
      }
      setDraftSaved(true);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "下書きの保存に失敗しました。");
    } finally {
      setDraftBusy(false);
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
        <ListingImageSelector
          images={images}
          photoAssets={photoAssets}
          initialImages={initialDraft?.images ?? null}
          brandedImageKey={brandedImageKey}
          onChange={setSelectedImages}
        />
        <div className="mt-3 border border-gray-200 p-3 text-sm">
          <p className="font-semibold">ブランドロゴ（任意）</p>
          <p className="mt-1 text-gray-600">商品編集画面で選んだブランドのロゴを、出品用トップ画像の右下に入れます。元画像は変更しません。</p>
          <button type="button" disabled={brandLogoBusy || selectedImages.length >= 20} className="mt-2 border border-gray-400 px-3 py-2 disabled:opacity-50"
            onClick={async () => {
              setBrandLogoBusy(true); setBrandLogoError(null);
              try {
                const result = await createBrandedListingImageAction(inventoryId);
                setBrandedImageKey(result.storageKey);
                setDraftSaved(false);
              } catch (error) { setBrandLogoError(error instanceof Error ? error.message : "ロゴ画像の作成に失敗しました。"); }
              finally { setBrandLogoBusy(false); }
            }}>{brandLogoBusy ? "作成中…" : "ロゴ入りトップ画像を作る"}</button>
          {brandLogoError && <p role="alert" className="mt-2 text-red-700">{brandLogoError}</p>}
          {selectedImages.length >= 20 && <p className="mt-1 text-amber-700">画像が20枚選ばれています。1枚外してから作成してください。</p>}
          <p className="mt-1 text-gray-500">作成後に下書きを保存すると出品画像として使えます。</p>
        </div>
      </div>

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
            いません」「⚠ 配送ランクを確定できません」がここに出る。
            配送関連の警告だけは displayedWarnings 側で選択中の配送方法に
            合わせて作り直したもの(レビュー対応: 生成後に配送方法を
            切り替えても追従する)。 */}
        {aiQuality && displayedWarnings.length > 0 && (
          <div className="mb-2 border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
            <p className="font-bold">確認が必要な項目</p>
            <ul className="mt-1">
              {displayedWarnings.map((w, i) => (
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
            {/* §1 本文へ入れた配送方法を先頭に出す。選択と本文がずれていない
                ことを、生成のたびに目で確かめられるようにする。 */}
            <p>
              本文へ入れた配送方法:{" "}
              <span className="font-bold text-gray-700">
                {aiQuality.shipping.method === "SAGAWA" ? "佐川急便" : "らくらく家財便"}
              </span>
            </p>
            <p>
              らくらく家財便: {aiQuality.shipping.kazaiRank ?? "（未確定）"}
              {aiQuality.shipping.kazaiRank ? "ランク" : ""}
              {aiQuality.shipping.kazaiSumCm != null ? `（3辺合計${aiQuality.shipping.kazaiSumCm}cm）` : ""}
              {" ／ 佐川急便: "}
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
            <label htmlFor="listing-title" className="block text-[12px] text-gray-600">
              出品タイトル <span className="text-red-500">*</span>
            </label>
            <input
              id="listing-title"
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
          {/* 2026-09-04 追加指示 §1: 配送方法。既定は「らくらく家財便」で、
              必要な商品だけ担当者が「佐川急便」へ変える運用。
              **サイズやAIから自動で切り替えない** —— この選択が
              「◎発送について」の内容をそのまま決める。
              選択値は下書き(ListingDraft.shippingMethod)へ保存され、
              説明文を再生成しても維持される。 */}
          <div>
            <label htmlFor="listing-shipping-method" className="block text-[12px] text-gray-600">
              配送方法
            </label>
            <select
              id="listing-shipping-method"
              value={shippingMethod}
              onChange={(e) => onShippingMethodChange(e.target.value as ListingShippingMethod)}
              className="mt-0.5 w-56 border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
            >
              {LISTING_SHIPPING_METHODS.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="mt-0.5 text-[11px] text-gray-400">
              {shippingMethod === "SAGAWA"
                ? "商品説明の「◎発送について」に、3辺合計＋20cmで判定した佐川急便のサイズを入れます。"
                : "商品説明の「◎発送について」に、既存の送料計算と同じらくらく家財便のランクを入れます。"}
            </p>
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
          {/* 2026-09-14 指示書: 手動出品支援。準備した内容をMercari公式の
              出品画面へ貼り付けられる形でコピーできる——何も送信しない。 */}
          <button
            type="button"
            onClick={handleCopyForManualListing}
            disabled={!draft}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            title="タイトル・価格・コンディション・説明文をMercari公式の出品画面へ貼り付けられる形でコピーします（送信は行いません）"
          >
            出品内容をコピー（手動出品用）
          </button>
          {draftSaved && <span className="text-[12px] text-green-700">保存しました</span>}
          {copyState === "copied" && <span className="text-[12px] text-green-700">コピーしました</span>}
          {copyState === "error" && <span className="text-[12px] text-red-600">コピーできませんでした</span>}
        </div>
        {draftError && <p className="mt-2 text-[12px] text-red-600">{draftError}</p>}
      </div>

      {/* Mercari Shops CSV出力(2026-09-14、P2)向けのカテゴリー/ブランド
          選択。出品の実行導線ではない——公式マスタの検索・確定のみ。 */}
      <MercariCategoryMappingSection
        inventoryId={inventoryId}
        hasDraft={Boolean(draft)}
        channelListing={channelListing}
        onUpdated={setChannelListing}
      />

      {/* Mercari Shops出品の過去履歴(External Listing Status)。
          Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、
          カテゴリーマッピング入力・実出品ボタン・送料負担選択は削除した
          ——過去に出品したことがある商品(ChannelListingが既に存在する)
          についてのみ、その記録を読み取り専用で表示する。新規の商品は
          ChannelListingがそもそも作られないため、この節自体が出ない。 */}
      {channelListing && (
        <div className="mt-4 border border-gray-200 p-4">
          <p className="mb-2 text-[12px] font-bold text-gray-700">Mercari Shops 出品履歴（過去の記録・参照専用）</p>
          <dl className="grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
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
          <p className="mt-2 text-[11px] text-gray-400">
            Mercari Shops API連携は撤去されました。出品・再出品・価格変更はMercariの管理画面で直接行ってください。
          </p>
        </div>
      )}

      {/* BELLO統合業務OS指示書(2026-08-30) §67-68: 送料見積り(家財おまかせ便)。
          上の出品履歴と同じ理由でChannelListing存在時のみ表示する。 */}
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
