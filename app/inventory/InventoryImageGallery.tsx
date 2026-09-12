"use client";

import { useEffect, useReducer, useState } from "react";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";
import { InventoryThumbnail } from "./InventoryThumbnail";
import { effectiveListThumbnailKey, type InventoryImageRecord } from "@/lib/inventory/imageTypes";
import { initialBodyLoadState, reduceBodyLoadState, planHeroRender, planFullRender } from "./inventoryImageLoadState";

interface InventoryImageGalleryProps {
  images: InventoryImageRecord[];
  alt: string;
  /** Section heading rendered above the gallery (Phase C.5: "商品画像" / "傷・汚れ写真" — see the detail page). Omit to render with no heading, matching the original single-gallery layout. */
  title?: string;
  /** When true and `images` is empty, renders nothing at all rather than the "No Image" hero placeholder — used for the 傷・汚れ写真 group, where having none at all is the common case and a big empty placeholder box would just be clutter (spec §6/§11: don't over-build this screen). The 商品画像 group keeps the placeholder (hideIfEmpty defaults false) since every Inventory item is expected to have at least a representative photo. */
  hideIfEmpty?: boolean;
}

/**
 * Detail-page image display (spec §2/§3): a large main image (≈5x the
 * old thumbnail's area — big enough to actually check a furniture item's
 * condition) with the rest as a clickable thumbnail strip, and a click on
 * the main image opens a simple lightbox at as close to full resolution
 * as the viewport allows. No animation, no library — a plain fixed
 * overlay is exactly what spec asks for ("簡素なライトボックス形式で構
 * わない"). Esc closes it; ←/→ move between images when there's more
 * than one.
 *
 * 画像表示高速化・段階読込(P1、2026-09-12指示書 + 同日QA是正):
 * 原本(storageKey)を要求するのはライトボックスを開いた時だけ。
 * メイン画像は必ず「small(effectiveListThumbnailKey、一覧と同じ
 * 320px相当)」を先に確定表示し、mediumKeyがある画像だけ裏でmedium
 * (effectiveHeroKeyの960px相当)を読み込んで、その**本体の**onLoadが
 * 実際に成功した時だけ差し替える——署名URLが取れただけでは差し替え
 * ない。medium側が失敗してもsmallの表示は失われない。ストリップは
 * 常にeffectiveListThumbnailKey(一覧と全く同じ320px版)。
 *
 * 「読み込み中」の表示は署名URL解決だけで消さない——実際の<img>の
 * onLoadが発火するまで、URLがあってもオーバーレイで隠し続ける
 * (app/inventory/inventoryImageLoadState.tsのplanHeroRender/
 * planFullRenderが判定するのはそこ)。ライトボックスの原本も同様に
 * onLoad/onErrorを管理し、署名自体は成功したが本体(バイト列)の
 * 読み込みに失敗した場合も再試行UIを出す——再試行は
 * useInventoryImageUrlのretry()経由で必ず新しい署名を取り直す
 * (期限切れ/実体不整合を、キャッシュされた同じURLの再利用で
 * 見逃さないため)。
 *
 * 選択中の画像を切り替えたとき、旧画像に対して裏で進んでいた
 * medium/original読み込みの遅延イベントが新しい選択へ誤反映しない
 * ように、small/medium/originalそれぞれの読み込み状態は
 * inventoryImageLoadState.tsのreduceBodyLoadStateで「今どのキーを
 * 指しているか」ごと管理する(旧キーのイベントは黙って捨てる)。
 *
 * Phase C.5: rendered twice on the detail page — once for 商品画像
 * (normal), once for 傷・汚れ写真 (damage) — the exact same component
 * and lightbox both times (spec §11: "lightboxも両方で利用可能な構造")
 * rather than a second implementation. The caller is expected to have
 * already put the resolved top image first in `images` for the normal
 * group (see lib/inventory/imageTypes.ts's resolveTopImage) — this
 * component itself has no opinion on which image is "the" top one, it
 * just always shows whichever is first.
 */
export function InventoryImageGallery({ images, alt, title, hideIfEmpty = false }: InventoryImageGalleryProps) {
  const [selected, setSelected] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const current = images[selected] as InventoryImageRecord | undefined;

  // --- メイン画像: small先行 → mediumは本体onLoad成功時のみ差し替え ---
  const smallKey = current ? effectiveListThumbnailKey(current) : null;
  const { url: smallUrl, failed: smallResolveFailed } = useInventoryImageUrl(smallKey);
  const [smallBody, dispatchSmallBody] = useReducer(reduceBodyLoadState, initialBodyLoadState(smallKey));
  useEffect(() => {
    dispatchSmallBody({ type: "SELECT", key: smallKey });
  }, [smallKey]);

  // mediumKeyが無い画像は、effectiveHeroKeyがそのままsmallKeyへ落ちる
  // (thumbnailKey→storageKeyの同じフォールバック順)ので、mediumUrlは
  // 常にnullのまま——「medium段階が存在しない」を素直に表す。
  const mediumKey = current?.mediumKey ?? null;
  const { url: mediumUrl } = useInventoryImageUrl(mediumKey);
  const [mediumBody, dispatchMediumBody] = useReducer(reduceBodyLoadState, initialBodyLoadState(mediumKey));
  useEffect(() => {
    dispatchMediumBody({ type: "SELECT", key: mediumKey });
  }, [mediumKey]);
  // mediumUrlが解決したら裏(画面に出さない)でプリロードし、本体の
  // onload/onerrorだけを見る——表示中の<img>を差し替えるのはプリロード
  // が成功した後だけなので、ユーザーには「悪くなる方向の変化」が
  // 一切見えない。dispatchはmediumKeyそのものではなくクロージャで
  // 捕まえたキー(effect実行時点のmediumKey)を積むので、選択が切り
  // 替わって新しいSELECTが先に効いていれば、後から届くこのイベントは
  // reduceBodyLoadStateにより黙って無視される。
  useEffect(() => {
    if (!mediumUrl) return;
    const keyAtStart = mediumKey;
    if (!keyAtStart) return;
    const preload = new Image();
    preload.onload = () => dispatchMediumBody({ type: "LOADED", key: keyAtStart });
    preload.onerror = () => dispatchMediumBody({ type: "FAILED", key: keyAtStart });
    preload.src = mediumUrl;
  }, [mediumUrl, mediumKey]);

  const heroPlan = planHeroRender({
    smallUrl,
    smallResolveFailed,
    smallBody,
    mediumUrl,
    mediumBody,
  });

  // --- ライトボックス: 原本(storageKey)は開いている間だけ要求する ---
  // current自体はselectedが変わるたびに変わるので、ライトボックスを
  // 開いたまま←/→で切り替えても「選択中の1枚だけ」が新たに要求される
  // (スペック: 拡大時選択画像のみ取得)。
  const fullKey = lightboxOpen ? (current?.storageKey ?? null) : null;
  const { url: fullUrl, failed: fullResolveFailed, retry: retryFullUrl } = useInventoryImageUrl(fullKey);
  const [fullBody, dispatchFullBody] = useReducer(reduceBodyLoadState, initialBodyLoadState(fullKey));
  useEffect(() => {
    dispatchFullBody({ type: "SELECT", key: fullKey });
  }, [fullKey]);

  const fullPlan = planFullRender({ fullUrl, fullResolveFailed, fullBody });

  const retryFull = () => {
    if (!fullKey) return;
    dispatchFullBody({ type: "SELECT", key: fullKey }); // 表示中のfailedを一旦リセットしてloadingへ戻す
    retryFullUrl(); // 必ず新しい署名を取り直す(期限切れ/実体不整合をキャッシュ再利用で見逃さない)
  };

  useEffect(() => {
    if (!lightboxOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxOpen(false);
      if (e.key === "ArrowRight") setSelected((i) => Math.min(i + 1, images.length - 1));
      if (e.key === "ArrowLeft") setSelected((i) => Math.max(i - 1, 0));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, images.length]);

  if (images.length === 0) {
    if (hideIfEmpty) return null;
    return (
      <div>
        {title && <p className="mb-2 text-[11px] font-bold text-gray-400">{title}</p>}
        <InventoryThumbnail storageKey={null} alt={alt} size="hero" loading="eager" />
      </div>
    );
  }

  return (
    <div>
      <ConfigureAmplifyClientSide />
      {title && <p className="mb-2 text-[11px] font-bold text-gray-400">{title}</p>}
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block w-full cursor-zoom-in border border-gray-200 bg-gray-50"
        aria-label="画像を拡大表示"
      >
        {heroPlan.showFailedPlaceholder ? (
          <InventoryThumbnail storageKey={null} alt={alt} size="hero" loading="eager" />
        ) : heroPlan.mountSrc ? (
          <div className="relative h-[380px] w-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- S3 URL; see InventoryThumbnail's identical note. */}
            <img
              src={heroPlan.mountSrc}
              alt={alt}
              onLoad={() => smallKey && dispatchSmallBody({ type: "LOADED", key: smallKey })}
              onError={() => smallKey && dispatchSmallBody({ type: "FAILED", key: smallKey })}
              className={`h-[380px] w-full object-contain ${heroPlan.showLoadingOverlay ? "invisible" : ""}`}
            />
            {heroPlan.showLoadingOverlay && (
              <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-400">読み込み中…</div>
            )}
          </div>
        ) : (
          // まだ解決前(署名待ち) — heroPlan.showFailedPlaceholderが
          // 確定するまでは原本にも一切フォールバックしない、というのが
          // この画面の核心。
          <div className="flex h-[380px] w-full items-center justify-center text-[11px] text-gray-400">読み込み中…</div>
        )}
      </button>

      {images.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {images.map((img, i) => (
            <button
              key={img.storageKey}
              type="button"
              onClick={() => setSelected(i)}
              aria-label={`${i + 1}枚目を表示`}
              className={i === selected ? "ring-2 ring-gray-900" : "opacity-80 hover:opacity-100"}
            >
              <InventoryThumbnail storageKey={effectiveListThumbnailKey(img)} alt={`${alt} ${i + 1}`} size="medium" />
            </button>
          ))}
        </div>
      )}

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            aria-label="閉じる"
            className="absolute right-4 top-4 text-2xl leading-none text-white hover:text-gray-300"
          >
            ×
          </button>
          {images.length > 1 && selected > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected((i) => i - 1);
              }}
              aria-label="前の画像"
              className="absolute left-4 text-3xl leading-none text-white hover:text-gray-300"
            >
              ‹
            </button>
          )}
          {fullPlan.showFailedRetry ? (
            <div onClick={(e) => e.stopPropagation()} className="text-center text-[13px] text-white">
              <p>元画像の読み込みに失敗しました。</p>
              <button
                type="button"
                onClick={retryFull}
                className="mt-2 border border-white px-3 py-1 text-[12px] hover:bg-white hover:text-black"
              >
                再試行
              </button>
            </div>
          ) : fullPlan.mountSrc ? (
            <div className="relative flex max-h-full max-w-full items-center justify-center" onClick={(e) => e.stopPropagation()}>
              {/* eslint-disable-next-line @next/next/no-img-element -- S3 URL; see InventoryThumbnail's identical note. */}
              <img
                src={fullPlan.mountSrc}
                alt={alt}
                onLoad={() => fullKey && dispatchFullBody({ type: "LOADED", key: fullKey })}
                onError={() => fullKey && dispatchFullBody({ type: "FAILED", key: fullKey })}
                className={`max-h-full max-w-full object-contain ${fullPlan.showLoadingOverlay ? "invisible" : ""}`}
              />
              {fullPlan.showLoadingOverlay && (
                <div className="absolute text-[13px] text-white">読み込み中…</div>
              )}
            </div>
          ) : (
            <div onClick={(e) => e.stopPropagation()} className="text-[13px] text-white">
              読み込み中…
            </div>
          )}
          {images.length > 1 && selected < images.length - 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected((i) => i + 1);
              }}
              aria-label="次の画像"
              className="absolute right-4 text-3xl leading-none text-white hover:text-gray-300"
            >
              ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}
