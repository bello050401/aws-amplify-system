"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { fetchAuthSession } from "aws-amplify/auth";

const RETRY_DELAYS_MS = [400, 1200]; // total ≤3 attempts

/**
 * ## 資格情報の取得が画像の枚数ぶん走っていた問題(実測)
 *
 * `getUrl()`は署名にCognito Identity Poolの一時認証情報を要る。一覧は
 * 各行が独立したInventoryThumbnailなので、mount時に全行がほぼ同時に
 * `getUrl()`を呼ぶ。Amplifyは資格情報をキャッシュするが、**1件目が
 * 返る前に残り全部が走る**ため誰もキャッシュに当たらない。Stagingの
 * 在庫一覧(画像100枚)で実測した1画面あたりの通信:
 *
 *   100 x GetId 200
 *    99 x GetCredentialsForIdentity 200
 *     3〜27 x GetCredentialsForIdentity 400 (TooManyRequestsException)
 *
 * つまり画像1枚につきIdentity Poolを2往復し、その一部がスロットリング
 * で弾かれていた。弾かれた分はこのhookのリトライで復旧するので画像は
 * 最終的に出るが、無駄な往復・表示の遅れ・Cognitoのレート消費になる。
 *
 * 対策は2段構え:
 *
 * 1. **warmCredentials()** — 最初の1回だけ`fetchAuthSession()`を走らせ、
 *    全hookはその同じPromiseを待つ。解決した時点でAmplify内部の資格情報
 *    キャッシュが埋まっているので、後続の`getUrl()`は往復ゼロで済む。
 * 2. **同時実行数の上限** — それでも署名処理が一斉に走らないよう、
 *    getUrl自体を少数ずつに絞る。期限切れでAmplifyが再取得する場合でも
 *    殺到しない。
 *
 * どちらも「1枚目を待ってから残りを流す」だけで、キーごとの結果は
 * 変わらない。
 */
let credentialsWarmup: Promise<void> | null = null;
function warmCredentials(): Promise<void> {
  // 失敗しても握りつぶす — 認証が無い/切れている場合はgetUrl側が
  // 本来のエラーを出すべきで、ここで画像を永久に止めない。
  if (!credentialsWarmup) credentialsWarmup = fetchAuthSession().then(() => undefined).catch(() => undefined);
  return credentialsWarmup;
}

const MAX_CONCURRENT_SIGNS = 6;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_SIGNS) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  waiting.shift()?.();
}

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

    // 署名の実行本体。資格情報のウォームアップ待ち → 同時実行枠の取得、
    // の順に通してからgetUrlを呼ぶ。
    const signOnce = async (): Promise<string> => {
      await warmCredentials();
      await acquireSlot();
      try {
        const { url } = await getUrl({
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
        });
        return url.toString();
      } finally {
        releaseSlot();
      }
    };

    const attempt = (retriesLeft: number) => {
      signOnce()
        .then((resolved) => {
          if (cancelled) return;
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
