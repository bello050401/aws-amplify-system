"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";

const RETRY_DELAYS_MS = [400, 1200]; // total ≤3 attempts

/**
 * 第五ラウンド§7/§43(P0-C性能監査で発覚): このhookは元々
 * storageKeyごとに完全に独立した`getUrl()`呼び出しをコンポーネントの
 * mountのたびに行っていた — 一覧ページの各行が別々のInventoryThumbnail
 * インスタンスであるため、50件表示なら初回描画で最大50並列の
 * signed URL生成が走り、かつ「一覧→詳細→戻る」で同じ一覧ページへ
 * 戻った際も、Reactがコンポーネントツリーを再マウントすれば
 * (Next.js App RouterのRouter Cacheが効かない場合)全く同じ50件分を
 * もう一度生成し直していた。
 *
 * 対象オブジェクトは呼び出し元コメントの通りキー自体が不変(新規
 * アップロードは常に新しいUUIDキー)なので、signed URLの署名内容
 * (パス)自体はいつ生成しても同じだが、**URLの有効期限だけは時間
 * 経過で切れる**(Amplify Storageの`getUrl`既定expiresIn=900秒)。
 * そのため「無期限にキャッシュしてよい」わけではなく、期限切れの
 * 恐れが無い範囲(既定の900秒よりはっきり短い10分=600秒)だけ
 * モジュールスコープのMapで共有することで、同一セッション内で複数
 * コンポーネントインスタンス/再マウントをまたいで再署名コストを
 * 避ける——ページを再読み込みすれば自然に空になる(永続化しない、
 * 単なるその場のメモリキャッシュ)。
 */
const URL_CACHE_TTL_MS = 10 * 60 * 1000;
const urlCache = new Map<string, { url: string; expiresAt: number }>();

export function useInventoryImageUrl(storageKey: string | null): { url: string | null; failed: boolean } {
  const cached = storageKey ? urlCache.get(storageKey) : undefined;
  const cachedFresh = cached && cached.expiresAt > Date.now() ? cached.url : null;
  const [url, setUrl] = useState<string | null>(cachedFresh);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storageKey) {
      setUrl(null);
      setFailed(false);
      return;
    }
    const hit = urlCache.get(storageKey);
    if (hit && hit.expiresAt > Date.now()) {
      setUrl(hit.url);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setUrl(null);
    setFailed(false);

    const attempt = (retriesLeft: number) => {
      getUrl({
        path: storageKey,
        // BELLO統合改修 master指示書 Phase B優先度9 — every inventory/*
        // object's key is a fresh UUID that's never overwritten in place
        // (a new upload always gets a brand-new key), so the object at
        // any given key is genuinely immutable and safe to cache
        // "forever" in the browser. This response-header override covers
        // every object regardless of when it was uploaded (new uploads
        // also set the same Cache-Control at PutObject time — see
        // lib/inventory/thumbnail.ts's INVENTORY_IMAGE_CACHE_CONTROL —
        // this is what makes it effective for images uploaded before
        // that existed, too).
        options: { cacheControl: "public, max-age=31536000, immutable" },
      })
        .then(({ url }) => {
          if (cancelled) return;
          const resolved = url.toString();
          urlCache.set(storageKey, { url: resolved, expiresAt: Date.now() + URL_CACHE_TTL_MS });
          setUrl(resolved);
        })
        .catch((err) => {
          if (cancelled) return;
          if (retriesLeft > 0) {
            const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - retriesLeft] ?? 1200;
            setTimeout(() => !cancelled && attempt(retriesLeft - 1), delay);
            return;
          }
          console.error(`[useInventoryImageUrl] getUrl failed for "${storageKey}" after retries:`, err);
          setFailed(true);
        });
    };
    attempt(RETRY_DELAYS_MS.length);

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  return { url, failed };
}
