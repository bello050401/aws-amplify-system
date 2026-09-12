"use client";

import { useEffect, useRef, useState } from "react";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

const SIZE_CLASSES = {
  small: "h-10 w-10", // was the only size; kept for anywhere not yet migrated
  medium: "h-[60px] w-[60px]", // detail gallery's thumbnail strip
  // Phase C.5 §10: the list table's image column, specifically — a 3:2
  // box (matching a typical landscape product photo) rather than a
  // square, so a 3:2 source image displays uncropped instead of losing
  // its left/right or top/bottom edges. Height is unchanged from
  // "medium" on purpose (spec: don't grow the row), only the width
  // grows to fit the wider box.
  list: "h-[60px] w-[90px]",
  large: "h-20 w-full", // unused after the detail-page gallery rework, kept for any other small-preview use (e.g. ImageEditor slots)
  hero: "h-[380px] w-full", // detail page main image / no-image fallback
} as const;

// "list" uses object-contain (never crop — letterbox on a white
// background instead) since its whole point is showing a 3:2 photo
// uncropped; every other size keeps the previous object-cover behavior,
// where a cropped square/fixed box reads fine at that size.
const CONTAIN_SIZES: ReadonlySet<keyof typeof SIZE_CLASSES> = new Set(["list"]);

/**
 * Resolves an `inventory/*` Storage key to a viewable URL client-side, one
 * request per distinct key (via useInventoryImageUrl — see that file for
 * the retry rationale). Storage access is Cognito-group scoped (see
 * amplify/storage/resource.ts) — no public/guest rule — so this only
 * works for a signed-in ADMIN/EDITOR/VIEWER, which is exactly who ever
 * reaches this component (it only renders inside the (protected) route
 * group).
 */
export function InventoryThumbnail({
  storageKey,
  alt,
  size = "small",
  loading = "lazy",
}: {
  storageKey: string | null;
  alt: string;
  size?: keyof typeof SIZE_CLASSES;
  /**
   * BELLO統合改修 master指示書 Phase B優先度7 (ファーストビュー優先/
   * 遅延読み込み) — native `<img loading>`, no library needed. Default
   * "lazy" for every ordinary thumbnail (list rows scrolled off-screen
   * never even start downloading); the detail page's "hero" image passes
   * "eager" explicitly (see InventoryImageGallery.tsx) since it's always
   * the very first thing that screen shows.
   */
  loading?: "lazy" | "eager";
}) {
  // 画像表示高速化・段階読込(P1) — 画面外にある(loading="lazy"の)
  // サムネイルは、実際に画面内(またはその手前)に入るまで署名解決
  // 自体を始めない。IntersectionObserver未対応環境(旧ブラウザ/SSR中)
  // では従来どおり即時解決にフォールバックする(悪化させない側に倒す)。
  // 先頭の可視画像は初回描画時点で既に交差済みなのでobserverが即座に
  // isIntersecting=trueを返し、実質的にlazy待ちが発生しない。
  const [isNearViewport, setIsNearViewport] = useState(loading !== "lazy");
  // divとimgのどちらか一方だけが描画される(状態遷移で入れ替わる)ため、
  // 型の異なる2つのref propへ同じ参照先を渡せるコールバックrefにする
  // — RefObject<Div|Img>だとどちらのref propとも構造的に合わない。
  const elementRef = useRef<HTMLDivElement | HTMLImageElement | null>(null);
  const setElementRef = (node: HTMLDivElement | HTMLImageElement | null) => {
    elementRef.current = node;
  };

  useEffect(() => {
    if (loading !== "lazy" || isNearViewport || !storageKey) return;
    const el = elementRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }, // 少し手前から解決を始める — スクロールでちょうど見える瞬間にまだ未解決、を避ける
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, isNearViewport, storageKey]);

  const { url, failed: resolveFailed } = useInventoryImageUrl(isNearViewport ? storageKey : null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [storageKey]);
  const failed = resolveFailed || loadFailed;
  const fitClass = CONTAIN_SIZES.has(size) ? "object-contain" : "object-cover";

  if (!storageKey || failed) {
    return (
      <div
        className={`flex ${SIZE_CLASSES[size]} shrink-0 items-center justify-center overflow-hidden border border-gray-200 bg-gray-50 text-[9px] text-gray-400`}
      >
        <ConfigureAmplifyClientSide />
        No Image
      </div>
    );
  }

  if (!isNearViewport) {
    // まだ画面外 — サイズだけ確保した空箱。「No Image」の文字は出さない
    // (実際には画像があるのに無いように見えてしまうのを避ける)。
    return <div ref={setElementRef} className={`${SIZE_CLASSES[size]} shrink-0 border border-gray-200 bg-gray-50`} />;
  }

  return (
    // Fixed pixel height AND width (SIZE_CLASSES) plus object-cover means
    // this never takes on the source photo's own aspect ratio — a
    // portrait-oriented product photo gets cropped to this exact box,
    // same as a landscape one, so it can never grow a table row taller
    // than any other. `shrink-0` stops a flex/table layout from
    // squeezing it narrower under pressure elsewhere in the row, and
    // `overflow-hidden` is a second guarantee on top of object-cover
    // that nothing paints outside this box regardless of the source
    // image's intrinsic size. Every caller (the list table, both plain
    // and 詳細検索-filtered, and the detail page's gallery thumbnails)
    // renders through this exact same component/props — there is no
    // second, differently-sized thumbnail implementation anywhere in
    // this app for either of them to diverge from.
    // eslint-disable-next-line @next/next/no-img-element -- S3 URL, arbitrary/rotating host; next/image would need remotePatterns for a bucket domain that doesn't exist until deploy.
    <img
      ref={setElementRef}
      src={url ?? undefined}
      alt={alt}
      loading={loading}
      onError={(e) => {
        // getUrl() succeeded (a valid presigned URL) but the browser
        // still couldn't load it — e.g. the object doesn't actually
        // exist at that key. Falls back to the same placeholder instead
        // of leaving a permanently broken-image icon.
        console.error(`[InventoryThumbnail] image failed to load for "${storageKey}":`, e);
        setLoadFailed(true);
      }}
      className={`${SIZE_CLASSES[size]} shrink-0 overflow-hidden border border-gray-200 ${fitClass} bg-gray-50`}
    />
  );
}
