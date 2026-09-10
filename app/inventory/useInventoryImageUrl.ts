"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { fetchAuthSession } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { ImageUrlResolver, type AuthContext, type SignedUrlResult } from "./inventoryImageUrlResolver";

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
 * 対策は2段構え(inventoryImageUrlResolver.ts側): 最初の1回だけ
 * `fetchAuthSession()`を走らせ全呼び出しが相乗りする、かつgetUrl自体の
 * 同時実行数を絞る。詳細と、reloadを跨ぐ再利用・重複署名の削減・
 * 認証切替との競合の調停ロジックは inventoryImageUrlResolver.ts の
 * コメントを参照(この hook はそのReactアダプタに過ぎない)。
 */

function readSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.sessionStorage;
    // 一部ブラウザ(Safariのプライベートブラウズ等)はプロパティ自体は
    // 読めても最初の書き込みで例外を投げる。ここで一度触っておく。
    const probeKey = "__bello_inventory_image_cache_probe__";
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

async function fetchRealAuthContext(): Promise<AuthContext | null> {
  const session = await fetchAuthSession();
  if (!session.identityId) return null;
  return {
    identityId: session.identityId,
    // session.tokensの有無が「本当にサインイン済みか」の判定基準 —
    // 他のBELLOコードの認証チェックと同じ(see app/inventory/login/page.tsx)。
    // guestのIdentity PoolアクセスにもidentityIdは発行されるがtokensは無い。
    isAuthenticated: !!session.tokens,
    credentialsExpiresAtMs: session.credentials?.expiration?.getTime() ?? null,
  };
}

async function signRealUrl(storageKey: string): Promise<SignedUrlResult> {
  const { url, expiresAt } = await getUrl({
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
  return { url: url.toString(), expiresAt: expiresAt ?? null };
}

const resolver = new ImageUrlResolver({
  fetchAuthContext: fetchRealAuthContext,
  signUrl: signRealUrl,
  storage: readSessionStorage(),
});

// ログアウト/別ユーザーへの切替(同じタブ内、reload無し)で必ず破棄・
// 分離する。tokenRefresh_failureも資格情報が失効した合図なので同様に
// 扱う。tokenRefreshは同じユーザーのまま資格情報だけ更新されたケース
// なので全破棄はせず、次回の署名で新しいcredentials.expirationを
// 拾えるようwarmupだけ作り直す(resolver.resetAuthWarmup)。
Hub.listen("auth", ({ payload }) => {
  if (payload.event === "signedOut" || payload.event === "signedIn" || payload.event === "tokenRefresh_failure") {
    resolver.invalidateAll();
  } else if (payload.event === "tokenRefresh") {
    resolver.resetAuthWarmup();
  }
});

export function useInventoryImageUrl(storageKey: string | null): { url: string | null; failed: boolean } {
  // storageKeyがprops経由で変わった場合、useStateの初期値はmount時
  // にしか効かないため、この「render中に検知して同期的にリセットする」
  // パターンが無いと、新しいキーのeffectが走るまでの1フレーム、前の
  // キーのURLを表示してしまう(QA指摘)。
  const [renderedKey, setRenderedKey] = useState(storageKey);
  const [url, setUrl] = useState<string | null>(storageKey ? resolver.getCachedUrl(storageKey) : null);
  const [failed, setFailed] = useState(false);

  if (storageKey !== renderedKey) {
    setRenderedKey(storageKey);
    setUrl(storageKey ? resolver.getCachedUrl(storageKey) : null);
    setFailed(false);
  }

  useEffect(() => {
    if (!storageKey) {
      setUrl(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    // signedOut/signedInで張り直した「新しい試行」が、それより前に
    // 始まっていた「古い試行」の遅れて来たエラー(setFailed(true))に
    // 上書きされないようにするための世代カウンタ。resolve()自体の
    // {stale:true}判定(キャッシュ書き込みの防止)とは別の関心事 —
    // こちらはこのhookインスタンス内でのリトライ/エラー表示だけを
    // 対象にする。
    let localGeneration = 0;

    const attempt = (retriesLeft: number, myGeneration: number) => {
      resolver
        .resolve(storageKey)
        .then((result) => {
          if (cancelled || myGeneration !== localGeneration) return;
          if ("stale" in result) return; // signedOut/signedInに追い越された — 下のstart()が張り直した試行に任せる
          setUrl(result.url);
          setFailed(false);
        })
        .catch((err) => {
          if (cancelled || myGeneration !== localGeneration) return;
          if (retriesLeft > 0) {
            const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - retriesLeft] ?? 1200;
            setTimeout(() => {
              if (!cancelled && myGeneration === localGeneration) attempt(retriesLeft - 1, myGeneration);
            }, delay);
            return;
          }
          console.error(`[useInventoryImageUrl] getUrl failed for "${storageKey}" after retries:`, err);
          setFailed(true);
        });
    };

    const start = () => {
      localGeneration++;
      const myGeneration = localGeneration;
      const immediate = resolver.getCachedUrl(storageKey);
      if (immediate) {
        setUrl(immediate);
        setFailed(false);
      } else {
        setUrl(null);
        setFailed(false);
        attempt(RETRY_DELAYS_MS.length, myGeneration);
      }
    };

    start();

    // signedOut/signedIn(同じタブ内、reload無し)がmount中に起きたら、
    // 表示中の画像(前のユーザーのものかもしれない)を即座に捨てて、
    // 現在の認証状態で解決し直す。resolve()自身の古い試行は{stale:
    // true}を返すだけで表示にもキャッシュにも反映されないので、ここで
    // 明示的に取り直さない限り新しい画像は出ない。localGenerationを
    // 進めることで、古い試行が後からエラーで終わってもこの新しい
    // 試行の結果を上書きしない。
    const unsubscribe = resolver.subscribeInvalidate(() => {
      if (cancelled) return;
      setUrl(null);
      setFailed(false);
      start();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [storageKey]);

  return { url, failed };
}
