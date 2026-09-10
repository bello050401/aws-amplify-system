/**
 * Dependency-free orchestration for useInventoryImageUrl.ts's auth ↔ cache
 * race conditions.
 *
 * QAレビュー(task_b703843dca6eac5d79 → task_a49a5ef8481b21f322)で指摘された
 * 問題: hookのuseEffect本体に直接書かれていたキャッシュ/認証の調停ロジックは
 * Reactとaws-amplifyへの依存が無いと動かせず(このworktreeにnode_modulesが
 * 無い制約もあり)、境界ケース — 署名中にログアウト/別ユーザーへの切替が
 * 挟まる、認証取得の待ち中にauthが変わる、期限切れ資格情報が握りつぶされて
 * 再試行されない、等 — を実際に再現して固定するテストが書けなかった
 * (inventoryImageUrlCache.tsの36件は純粋なキャッシュ規則しか見ていない)。
 *
 * このモジュールは「いつgetUrlを呼ぶか/いつキャッシュを読み書きしてよいか/
 * いつ結果を捨てるべきか」という調停ロジックだけを、fetchAuthSession/
 * getUrl/Hubを実引数として差し込めるクラスに切り出す。これにより
 * scripts/verify-inventory-image-resolver.tsが本物のReact/amplifyを
 * 一切ロードせず、フェイクの資格情報関数・フェイクの署名関数・手動で
 * 発火させるinvalidateAll()を使って「Aの署名がログアウト後に遅延解決する」
 * ようなシナリオを決定的に再現できる。useInventoryImageUrl.ts自体は
 * このクラスをインスタンス化してuseState/useEffectに繋ぐだけの薄い
 * アダプタになる(このモジュールの外に置く調停ロジックは無い)。
 */

import {
  InFlightMap,
  PersistentImageUrlCache,
  isFresh,
  isSameIdentity,
  safeExpiryMs,
  type ImageUrlCacheEntry,
  type StorageLike,
} from "./inventoryImageUrlCache";

export interface AuthContext {
  /** Cognito Identity Poolのidentity id。guest(未認証)アクセスでも発行される。 */
  identityId: string;
  /**
   * true = Cognito User Poolのトークンを伴う本当のサインイン
   * (`session.tokens`が存在する — 他のBELLOコードの認証判定と同じ基準、
   * see app/inventory/login/page.tsx)。false = 未認証のguest identity。
   * identityIdだけでは区別できない(guestにもidentityIdは発行される)ため、
   * このフラグと合わせてキャッシュのidentityキーを組み立てる —
   * see identityKeyFor()。
   */
  isAuthenticated: boolean;
  /** epoch ms。取得できない場合はnull。 */
  credentialsExpiresAtMs: number | null;
}

export interface SignedUrlResult {
  url: string;
  expiresAt: Date | null;
}

export type ResolveResult = { readonly url: string } | { readonly stale: true };

export interface ImageUrlResolverOptions {
  fetchAuthContext: () => Promise<AuthContext | null>;
  signUrl: (storageKey: string) => Promise<SignedUrlResult>;
  storage: StorageLike | null;
  /** テスト用の時計注入。省略時はDate.now。 */
  now?: () => number;
  maxConcurrentSigns?: number;
  urlCacheTtlMs?: number;
  safetyMarginMs?: number;
}

const DEFAULT_URL_CACHE_TTL_MS = 10 * 60 * 1000; // getUrlがexpiresAtを返さなかった場合だけの保守的な既定値
const DEFAULT_SAFETY_MARGIN_MS = 30 * 1000; // 期限ぎりぎりのURLを配らない/保存しないための余裕
const DEFAULT_MAX_CONCURRENT_SIGNS = 6;
const UNKNOWN_IDENTITY = "unknown"; // 未認証(auth===null)時、メモリキャッシュのみで使う識別子

function identityKeyFor(auth: AuthContext): string {
  // 認証済み/guestで名前空間を分ける — 同じidentityIdをguestと認証済み
  // ユーザーが共有する構成であっても、片方のキャッシュをもう片方に
  // 誤って使い回さない(QA指摘: 「identityIdだけでは認証済み保証にならない」)。
  return `${auth.isAuthenticated ? "auth" : "guest"}:${auth.identityId}`;
}

export class ImageUrlResolver {
  private readonly fetchAuthContext: () => Promise<AuthContext | null>;
  private readonly signUrl: (storageKey: string) => Promise<SignedUrlResult>;
  private readonly now: () => number;
  private readonly maxConcurrentSigns: number;
  private readonly urlCacheTtlMs: number;
  private readonly safetyMarginMs: number;

  private readonly urlCache = new Map<string, ImageUrlCacheEntry>();
  private readonly inFlight = new InFlightMap<ResolveResult>();
  private readonly persistentCache: PersistentImageUrlCache;
  private readonly invalidateListeners = new Set<() => void>();

  /** signedOut/signedIn/tokenRefresh_failureのたびに1つ進む世代番号。
   *  resolve()はawaitの前後でこれを比較し、開始時と一致しない結果は
   *  古い認証状態で生まれたものとして保存も返却も拒否する。 */
  private generation = 0;
  private authContextPromise: Promise<AuthContext | null> | null = null;
  private inFlightSlots = 0;
  private readonly waitingForSlot: (() => void)[] = [];

  constructor(options: ImageUrlResolverOptions) {
    this.fetchAuthContext = options.fetchAuthContext;
    this.signUrl = options.signUrl;
    this.now = options.now ?? Date.now;
    this.maxConcurrentSigns = options.maxConcurrentSigns ?? DEFAULT_MAX_CONCURRENT_SIGNS;
    this.urlCacheTtlMs = options.urlCacheTtlMs ?? DEFAULT_URL_CACHE_TTL_MS;
    this.safetyMarginMs = options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.persistentCache = new PersistentImageUrlCache(options.storage);
  }

  /**
   * 同期の即時読み取り専用。mountの初期state・storageKey変更時の
   * render中リセット(hook側)に使う。urlCacheはinvalidateAll()で
   * 同期的にclear()されるので、ここで読めるのは常に現在の世代の
   * エントリだけ — 別途identity照合をする必要は無い。
   */
  getCachedUrl(storageKey: string): string | null {
    const hit = this.urlCache.get(storageKey);
    return isFresh(hit, this.now()) ? hit.url : null;
  }

  /**
   * ログアウト/別ユーザーへの切替(同じタブ内、reload無し)で呼ぶ。
   * 進行中のresolve()を中断することはできないが、(1)世代を進めて
   * それらの結果が保存/採用されないようにし、(2)inFlightの登録を
   * 消して以降の新しい呼び出しがその古い進行中Promiseに相乗りしない
   * ようにし、(3)購読者(mount中のhookインスタンス)に即座に
   * 「表示中の画像を捨てて良い」と知らせる。
   */
  invalidateAll(): void {
    this.generation++;
    this.urlCache.clear();
    this.inFlight.clear();
    this.persistentCache.clearAll();
    this.authContextPromise = null;
    for (const listener of this.invalidateListeners) listener();
  }

  /**
   * tokenRefresh(同じユーザーのまま資格情報だけ更新)相当。全破棄はせず
   * 次回のresolve()がwarmupし直して新しいcredentials.expirationを
   * 拾えるようにするだけ。
   */
  resetAuthWarmup(): void {
    this.authContextPromise = null;
  }

  /** hookのuseEffectから登録する。signedOut/signedIn時に表示を即座に
   *  クリアして再解決を始めるためのフック。 */
  subscribeInvalidate(listener: () => void): () => void {
    this.invalidateListeners.add(listener);
    return () => {
      this.invalidateListeners.delete(listener);
    };
  }

  private async getAuthContext(): Promise<AuthContext | null> {
    if (!this.authContextPromise) {
      this.authContextPromise = this.fetchAuthContext().catch(() => null);
    }
    const ctx = await this.authContextPromise;
    const isStale = ctx === null || (ctx.credentialsExpiresAtMs !== null && ctx.credentialsExpiresAtMs <= this.now());
    if (isStale) {
      // 失敗(null)も期限切れも、Hubイベント無しに永久固定させない —
      // 次のresolve()呼び出し(このリクエスト自身の再試行、または別の
      // storageKeyからの呼び出し)がfetchAuthContext()をやり直せるように
      // メモ化を解除する。この呼び出し自体は今取れたctx(null/期限切れ)
      // をそのまま返す — signUrl側が本来のエラー(未認証/期限切れ)を
      // 出すべきなので、ここで画像を永久に止めない。
      this.authContextPromise = null;
    }
    return ctx;
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlightSlots < this.maxConcurrentSigns) {
      this.inFlightSlots++;
      return;
    }
    await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
    this.inFlightSlots++;
  }

  private releaseSlot(): void {
    this.inFlightSlots--;
    this.waitingForSlot.shift()?.();
  }

  /**
   * storageKeyを解決する。同じキーへの並行呼び出しは1本化される
   * (InFlightMap)。戻り値が`{stale: true}`の場合、開始からawaitの
   * どこかでinvalidateAll()が挟まったということ — 呼び出し側(hook)は
   * setUrlを呼ばず、キャッシュへの書き込みも既にこのメソッド内で
   * スキップ済み。
   */
  resolve(storageKey: string): Promise<ResolveResult> {
    const generationAtStart = this.generation;

    const cached = this.urlCache.get(storageKey);
    if (isFresh(cached, this.now())) {
      return Promise.resolve({ url: cached.url });
    }

    return this.inFlight.run(storageKey, async () => {
      const auth = await this.getAuthContext();
      const identityKey = auth ? identityKeyFor(auth) : null;

      if (identityKey) {
        const persisted = this.persistentCache.get(storageKey);
        if (persisted && isSameIdentity(persisted, identityKey) && isFresh(persisted, this.now())) {
          if (this.generation !== generationAtStart) return { stale: true } as const;
          this.urlCache.set(storageKey, persisted);
          return { url: persisted.url } as const;
        }
      }

      await this.acquireSlot();
      let signed: SignedUrlResult;
      try {
        signed = await this.signUrl(storageKey);
      } finally {
        this.releaseSlot();
      }

      // 署名が返ってきた時点で世代が進んでいたら、signedOut/signedInが
      // await中に挟まったということ — このURLがどのidentityで署名された
      // ものか(Amplify内部の資格情報が既に切り替わっている可能性がある)
      // 確証が持てないので、保存も呼び出し元への返却も拒否する。
      if (this.generation !== generationAtStart) return { stale: true } as const;

      const entry: ImageUrlCacheEntry = {
        url: signed.url,
        expiresAt: safeExpiryMs(
          signed.expiresAt?.getTime() ?? this.now() + this.urlCacheTtlMs,
          auth?.credentialsExpiresAtMs ?? null,
          this.safetyMarginMs,
        ),
        identityId: identityKey ?? UNKNOWN_IDENTITY,
      };
      this.urlCache.set(storageKey, entry);
      // 認証済み(guestでない)と確認できた場合だけ永続化する — guestや
      // 未確認(auth===null)のまま保存すると、後で別ユーザー/認証済み
      // ユーザーがこのエントリを拾いかねない。
      if (auth?.isAuthenticated) this.persistentCache.set(storageKey, entry);
      return { url: entry.url } as const;
    });
  }
}
