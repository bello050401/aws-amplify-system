"use client";

import { useEffect, useRef, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { fetchAuthSession } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { ImageUrlResolver, type AuthContext, type SignedUrlResult, type ResolveResult } from "./inventoryImageUrlResolver";

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

// ---------------------------------------------------------------------
// 完全合成画像QAハーネス(画像表示高速化・段階読込 P1 QA是正)
//
// 実S3/Cognitoに一切到達せずに、段階読込(small→medium)・拡大時のみ
// 原本要求・本体失敗/再試行を実ブラウザ(Codex含む)で確認するための
// 入口。`lib/inventory/e2eFixtures.ts`が返す画像だけが
// `"e2e-fixture:<variant>"`というstorageKeyを持つ(実データは
// `crypto.randomUUID()`由来のキーしか持たないので絶対に衝突しない)。
//
// production buildでは`process.env.NODE_ENV`がwebpackにより文字列
// "production"へ静的に置換される(Next.jsの標準挙動)ため、この分岐は
// production向けバンドルからdead code eliminationで消える —
// lib/inventory/e2eFixtures.tsのisE2EFixtureModeActive()と同じ二重
// ゲートの考え方(そちらはNODE_ENV+INVENTORY_E2E_FIXTURES、こちらは
// NODE_ENV+storageKeyの命名規則で判定する、クライアント側では
// サーバー専用の環境変数を直接読めないため)。
//
// fetchAuthSession()/getUrl()を一切呼ばない — 実Cognito/S3が無い
// (amplify_outputs.jsonがプレースホルダの)環境でも、認証周りの遅延/
// 失敗に一切左右されずに合成画像の段階読込だけを検証できるようにする
// ための独立した経路(resolverの認証調停ロジックとは無関係)。
// ---------------------------------------------------------------------
const E2E_FIXTURE_PREFIX = "e2e-fixture:";

type E2EFixtureFailMode = "never" | "always" | "once";
interface E2EFixtureVariant {
  readonly path: string;
  readonly delayMs: number;
  readonly fail: E2EFixtureFailMode;
}

/** `missing.svg`は実在しない — 本物の404を発生させることで、シミュレートではなく実際のブラウザ本体失敗(onError)を再現する。 */
const E2E_FIXTURE_MISSING_PATH = "/e2e-fixtures/missing.svg";

const E2E_FIXTURE_VARIANTS: Record<string, E2EFixtureVariant> = {
  small: { path: "/e2e-fixtures/small.svg", delayMs: 0, fail: "never" },
  medium: { path: "/e2e-fixtures/medium.svg", delayMs: 0, fail: "never" },
  "medium-delayed": { path: "/e2e-fixtures/medium.svg", delayMs: 1200, fail: "never" },
  "medium-broken": { path: "/e2e-fixtures/medium.svg", delayMs: 0, fail: "always" },
  original: { path: "/e2e-fixtures/original.svg", delayMs: 0, fail: "never" },
  "original-delayed": { path: "/e2e-fixtures/original.svg", delayMs: 900, fail: "never" },
  // 1回目のライトボックス表示は本体失敗(404) → 再試行UIが出る → 再試行
  // (forceRefresh)すると2回目以降は成功する、という回復シナリオ専用。
  "original-recovers": { path: "/e2e-fixtures/original.svg", delayMs: 0, fail: "once" },
};

function isE2EFixtureKey(storageKey: string): boolean {
  return process.env.NODE_ENV !== "production" && storageKey.startsWith(E2E_FIXTURE_PREFIX);
}

// 同じタブ内で保持する呼び出し回数——"once"失敗モードが「1回目だけ失敗、
// 以降は成功」を実現するための最小限の状態。QA専用、実データには一切
// 影響しない(このMapのキーは常にe2e-fixture:接頭辞のみ)。
const e2eFixtureAttemptCounts = new Map<string, number>();

async function resolveE2EFixtureUrl(storageKey: string): Promise<SignedUrlResult> {
  const variant = storageKey.slice(E2E_FIXTURE_PREFIX.length);
  const spec = E2E_FIXTURE_VARIANTS[variant] ?? E2E_FIXTURE_VARIANTS.original;
  const attempt = (e2eFixtureAttemptCounts.get(storageKey) ?? 0) + 1;
  e2eFixtureAttemptCounts.set(storageKey, attempt);
  const shouldFail = spec.fail === "always" || (spec.fail === "once" && attempt === 1);
  if (spec.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
  return { url: shouldFail ? E2E_FIXTURE_MISSING_PATH : spec.path, expiresAt: null };
}

/** 実解決経路(resolver.resolve)とe2e合成経路のどちらを使うかをここで分岐する——実キーの解決は本番と一切変わらない。 */
async function resolveStorageKeyUrl(storageKey: string, forceRefresh: boolean): Promise<ResolveResult> {
  if (isE2EFixtureKey(storageKey)) {
    const signed = await resolveE2EFixtureUrl(storageKey);
    return { url: signed.url };
  }
  return resolver.resolve(storageKey, { forceRefresh });
}

function getCachedUrlFor(storageKey: string): string | null {
  // e2e fixtureキーは意図的にキャッシュを持たない(QAで毎回挙動を
  // 確認できるよう常に解決をやり直す——本番の署名URLキャッシュとは
  // 無関係な、影響範囲ゼロの経路)。
  if (isE2EFixtureKey(storageKey)) return null;
  return resolver.getCachedUrl(storageKey);
}

export function useInventoryImageUrl(storageKey: string | null): { url: string | null; failed: boolean; retry: () => void } {
  // storageKeyがprops経由で変わった場合、useStateの初期値はmount時
  // にしか効かないため、この「render中に検知して同期的にリセットする」
  // パターンが無いと、新しいキーのeffectが走るまでの1フレーム、前の
  // キーのURLを表示してしまう(QA指摘)。
  const [renderedKey, setRenderedKey] = useState(storageKey);
  const [url, setUrl] = useState<string | null>(storageKey ? getCachedUrlFor(storageKey) : null);
  const [failed, setFailed] = useState(false);
  // 画像表示高速化・段階読込(P1) — 3回の自動リトライを使い切って
  // failed=trueになった後、ユーザーが手動で再試行できるようにする
  // ためのnonce(ライトボックスの「再試行」ボタン用)。この値を増やす
  // ことだけがeffectの再実行トリガーになる — storageKey自体は変わって
  // いないので、resolver.resolve()を単純にもう一度呼ぶだけで済む
  // (resolver側は失敗をキャッシュしないので、これだけで新しい試行になる)。
  const [retryNonce, setRetryNonce] = useState(0);
  // retry()が呼ばれた直後の1回だけforceRefreshする——自動リトライ
  // (attempt内のsetTimeout連鎖)は対象外(そちらはまだ一度も成功して
  // いないのでキャッシュを迂回する意味が無い)。
  const forceNextResolveRef = useRef(false);

  if (storageKey !== renderedKey) {
    setRenderedKey(storageKey);
    setUrl(storageKey ? getCachedUrlFor(storageKey) : null);
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

    const attempt = (retriesLeft: number, myGeneration: number, forceRefresh: boolean) => {
      resolveStorageKeyUrl(storageKey, forceRefresh)
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
              // 自動リトライはforceRefreshしない(まだキャッシュに何も
              // 乗っていないので迂回する意味が無い) — 手動retry()専用。
              if (!cancelled && myGeneration === localGeneration) attempt(retriesLeft - 1, myGeneration, false);
            }, delay);
            return;
          }
          console.error(`[useInventoryImageUrl] getUrl failed for "${storageKey}" after retries:`, err);
          setFailed(true);
        });
    };

    const start = (forceRefresh: boolean) => {
      localGeneration++;
      const myGeneration = localGeneration;
      if (forceRefresh) {
        // 本体失敗後の手動再試行 — 「取得済み(に見える)URL」を信用
        // せず、必ず新しい試行として解決し直す。
        setUrl(null);
        setFailed(false);
        attempt(RETRY_DELAYS_MS.length, myGeneration, true);
        return;
      }
      const immediate = getCachedUrlFor(storageKey);
      if (immediate) {
        setUrl(immediate);
        setFailed(false);
      } else {
        setUrl(null);
        setFailed(false);
        attempt(RETRY_DELAYS_MS.length, myGeneration, false);
      }
    };

    const forceRefresh = forceNextResolveRef.current;
    forceNextResolveRef.current = false;
    start(forceRefresh);

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
      start(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // retryNonceはeffectを丸ごと再実行させるためだけの依存 — 値そのもの
    // は使わない(storageKeyが同じでも呼び出し元がretry()した回数分だけ
    // 新しいstart()を張り直す)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, retryNonce]);

  const retry = () => {
    forceNextResolveRef.current = true;
    setRetryNonce((n) => n + 1);
  };

  return { url, failed, retry };
}
