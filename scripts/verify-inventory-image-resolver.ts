/**
 * app/inventory/inventoryImageUrlResolver.ts の standalone verification
 * (同じ方針: scripts/verify-inventory-image-cache.ts が inventoryImageUrlCache.ts
 * の純粋規則だけを見るのに対し、こちらはfetchAuthSession/getUrl/Hubの
 * *タイミング* — 署名の待機中にログアウト/別ユーザーへの切替が挟まる、
 * 同時実行スロット待ち中にauthが変わる、資格情報取得が失敗/期限切れの
 * まま固定される、等 — を差し込んだフェイクで実際に再現し、
 * useInventoryImageUrl.ts の調停ロジック(このモジュールに切り出した
 * ImageUrlResolver)がQAレビューで指摘された競合を正しく捌くことを
 * hookの外側から固定する。React/aws-amplifyは一切importしない
 * (このworktreeにnode_modulesが無いため動かせない — see
 * qa-worktree-tooling-limits メモリ)。
 *
 * 型検査(tsc)は実行していない — このworktreeでは npx tsc が使えない
 * (承認待ちで止まる)ため未実施。ここでの合否は実行時の振る舞いのみ。
 *
 * Run with: npm run verify:inventory-image-resolver
 */
import { ImageUrlResolver, type AuthContext, type SignedUrlResult } from "@/app/inventory/inventoryImageUrlResolver";
import type { StorageLike } from "@/app/inventory/inventoryImageUrlCache";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assert(condition: boolean, label: string) {
  assertEqual(condition, true, label);
}

function makeFakeStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    get length() {
      return data.size;
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { identityId: "identity-a", isAuthenticated: true, credentialsExpiresAtMs: null, ...overrides };
}

function signedUrlFor(storageKey: string, overrides: Partial<SignedUrlResult> = {}): SignedUrlResult {
  return { url: `https://example.test/${storageKey}`, expiresAt: new Date(Date.now() + 900_000), ...overrides };
}

// テストごとに「今キューされている一連のmicrotask(await連鎖)を全部
// 片付けてから戻る」ために使う小さなヘルパー。setImmediateはmicrotask
// キューが尽きてから発火するマクロタスクなので、await/thenの連鎖が
// 何段あっても(queueMicrotaskの固定回数打ちより)確実に追いつける。
function tick(times = 1): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n++;
      if (n >= times) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

// ---------------------------------------------------------------------
// 1. A解決前にlogout→B→A遅延完了(保存・表示無し)
// ---------------------------------------------------------------------
async function testStaleResolveAfterAuthChangeIsNotSavedOrReturned() {
  let currentAuth = authContext({ identityId: "user-a" });
  const fetchAuthContext = async () => currentAuth;

  const signUrlCalls: { storageKey: string; deferred: ReturnType<typeof deferred<SignedUrlResult>> }[] = [];
  const signUrl = (storageKey: string) => {
    const d = deferred<SignedUrlResult>();
    signUrlCalls.push({ storageKey, deferred: d });
    return d.promise;
  };

  const storage = makeFakeStorage();
  const resolver = new ImageUrlResolver({ fetchAuthContext, signUrl, storage });

  // A(旧ユーザー)がstorageKey "K"の署名を開始する。
  const resultA = resolver.resolve("K");
  await tick(); // getAuthContext()～acquireSlot()～signUrl呼び出しまで進める
  assertEqual(signUrlCalls.length, 1, "シナリオ1: Aのresolve()がsignUrlを1回呼ぶ(まだ未解決)");

  // ログアウト→(別ユーザーとして)サインイン相当。
  currentAuth = authContext({ identityId: "user-b" });
  resolver.invalidateAll();

  // B(新ユーザー)が同じキー"K"を解決する — invalidateAll()でinFlightの
  // 登録が消えているので、Aの進行中Promiseには相乗りせず新規に走る。
  const resultB = resolver.resolve("K");
  await tick();
  assertEqual(signUrlCalls.length, 2, "シナリオ1: BのresolveはAの進行中Promiseに相乗りせず新しいsignUrlを呼ぶ");
  signUrlCalls[1].deferred.resolve(signedUrlFor("K", { url: "https://example.test/K-by-B" }));
  const settledB = await resultB;
  assert("url" in settledB && settledB.url === "https://example.test/K-by-B", "シナリオ1: Bは自分の結果を正常に受け取る");

  // ここでAの遅延していたsignUrlが今さら解決する。
  signUrlCalls[0].deferred.resolve(signedUrlFor("K", { url: "https://example.test/K-by-A-STALE" }));
  const settledA = await resultA;
  assertEqual(settledA, { stale: true }, "シナリオ1: Aの遅延解決は{stale:true} — 呼び出し元(hook)はsetUrlしない");
  assertEqual(resolver.getCachedUrl("K"), "https://example.test/K-by-B", "シナリオ1: Aの遅延解決はurlCacheを上書きしない(Bの結果のまま)");
  const persisted = JSON.parse(storage.getItem("bello:inventory:imgcache:v1:K") ?? "null");
  assertEqual(persisted?.url, "https://example.test/K-by-B", "シナリオ1: Aの遅延解決はsessionStorageも上書きしない(Bの結果のまま)");
}

// ---------------------------------------------------------------------
// 2. 待機slot中auth変更(同時実行スロットの空き待ちで止まっている間に
//    ログアウト/別ユーザーへの切替が起きても、後で通ったslotの結果は
//    保存も返却もされない)
// ---------------------------------------------------------------------
async function testAuthChangeWhileWaitingForSlotIsDetected() {
  let currentAuth = authContext({ identityId: "user-a" });
  const fetchAuthContext = async () => currentAuth;

  const signUrlCalls: { storageKey: string; deferred: ReturnType<typeof deferred<SignedUrlResult>> }[] = [];
  const signUrl = (storageKey: string) => {
    const d = deferred<SignedUrlResult>();
    signUrlCalls.push({ storageKey, deferred: d });
    return d.promise;
  };

  const resolver = new ImageUrlResolver({ fetchAuthContext, signUrl, storage: makeFakeStorage(), maxConcurrentSigns: 1 });

  // K1がスロットを1つ占有したまま止まる。
  const resultK1 = resolver.resolve("K1");
  await tick();
  assertEqual(signUrlCalls.length, 1, "シナリオ2: K1がスロットを占有してsignUrl待ち");

  // K2はスロット待ちの列に並ぶ(まだsignUrlは呼ばれない)。
  const resultK2 = resolver.resolve("K2");
  await tick();
  assertEqual(signUrlCalls.length, 1, "シナリオ2: K2はスロット待ちでsignUrlはまだ呼ばれない");

  // K2がスロットを取る前にログアウト/別ユーザー切替が起きる。
  currentAuth = authContext({ identityId: "user-b" });
  resolver.invalidateAll();

  // K1が終わってスロットが空き、K2がようやく走る。
  signUrlCalls[0].deferred.resolve(signedUrlFor("K1"));
  await resultK1.catch(() => undefined); // K1自体もinvalidate後の解決なのでstale
  await tick();
  assertEqual(signUrlCalls.length, 2, "シナリオ2: スロットが空いたのでK2のsignUrlがようやく呼ばれる");
  signUrlCalls[1].deferred.resolve(signedUrlFor("K2"));
  const settledK2 = await resultK2;
  assertEqual(settledK2, { stale: true }, "シナリオ2: スロット待ち中に認証が変わっていたK2の結果もstale扱いで保存・返却されない");
  assertEqual(resolver.getCachedUrl("K2"), null, "シナリオ2: K2はurlCacheにも書き込まれない");
}

// ---------------------------------------------------------------------
// 3. メモリ(sessionStorage永続)hitが別identityなら使わず、素直に
//    signUrlを呼び直す(同一世代内でも識別子が違えば信用しない)
// ---------------------------------------------------------------------
async function testPersistedHitFromDifferentIdentityIsRejected() {
  const storage = makeFakeStorage();
  // 「前回のタブセッション」相当: user-oldとして書き込まれたエントリが
  // reload後もsessionStorageに残っている。
  const seed = new ImageUrlResolver({
    fetchAuthContext: async () => authContext({ identityId: "user-old" }),
    signUrl: async (k) => signedUrlFor(k, { url: "https://example.test/by-old-user" }),
    storage,
  });
  await seed.resolve("shared-key");

  let signUrlCallCount = 0;
  const resolver = new ImageUrlResolver({
    // reload後、実際には別ユーザーとして認証されている(Hubイベント無しの
    // 初回ロード — generationは0のまま変わらない点がポイント)。
    fetchAuthContext: async () => authContext({ identityId: "user-new" }),
    signUrl: async (k) => {
      signUrlCallCount++;
      return signedUrlFor(k, { url: "https://example.test/by-new-user" });
    },
    storage,
  });
  const result = await resolver.resolve("shared-key");
  assertEqual(signUrlCallCount, 1, "シナリオ3: 別identityのpersistedエントリは信用されずsignUrlが呼ばれる");
  assert("url" in result && result.url === "https://example.test/by-new-user", "シナリオ3: 新ユーザー自身の結果が返る(旧ユーザーのURLではない)");
}

// ---------------------------------------------------------------------
// 4. guest(未認証Identity)/認証取得失敗
// ---------------------------------------------------------------------
async function testGuestIdentityNeverPersists() {
  const storage = makeFakeStorage();
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => authContext({ identityId: "guest-identity", isAuthenticated: false }),
    signUrl: async (k) => signedUrlFor(k),
    storage,
  });
  const result = await resolver.resolve("K");
  assert("url" in result, "シナリオ4a: guestでもgetUrl自体は成功しうる");
  assertEqual(resolver.getCachedUrl("K"), "url" in result ? result.url : null, "シナリオ4a: guestの結果もメモリキャッシュには乗る");
  assertEqual(storage.length, 0, "シナリオ4a: guest(未認証)の結果はsessionStorageへ絶対に永続化しない");
}

async function testAuthFetchFailureStillAttemptsSignUrl() {
  let signUrlCallCount = 0;
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => {
      throw new Error("network error fetching session");
    },
    signUrl: async (k) => {
      signUrlCallCount++;
      return signedUrlFor(k);
    },
    storage: makeFakeStorage(),
  });
  const result = await resolver.resolve("K");
  assertEqual(signUrlCallCount, 1, "シナリオ4b: 認証取得が失敗(reject)してもgetUrl自体は試みる(未認証時と同じ経路)");
  assert("url" in result, "シナリオ4b: signUrlが成功すれば結果は返る(本来のアクセス制御はgetUrl自身のエラーに委ねる)");
}

// ---------------------------------------------------------------------
// 5. 期限切れ/失敗した認証情報の再試行可能性(永久固定しない)
// ---------------------------------------------------------------------
async function testExpiredAuthContextIsRefetchedOnNextCall() {
  let callCount = 0;
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => {
      callCount++;
      // 常に「取得した時点で既に期限切れ」の資格情報を返す —
      // Hubイベントが一切発火しないシナリオを模す。
      return authContext({ identityId: "user-a", credentialsExpiresAtMs: Date.now() - 1000 });
    },
    signUrl: async (k) => signedUrlFor(k),
    storage: makeFakeStorage(),
  });
  await resolver.resolve("K1");
  await resolver.resolve("K2"); // 別キーでurlCacheの早期returnを避ける
  assertEqual(callCount, 2, "シナリオ5a: 期限切れの認証情報はメモ化されず、次の呼び出しで再取得される");
}

async function testFailedAuthContextIsRetriedOnNextCall() {
  let callCount = 0;
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => {
      callCount++;
      throw new Error("transient failure");
    },
    signUrl: async (k) => signedUrlFor(k),
    storage: makeFakeStorage(),
  });
  await resolver.resolve("K1");
  await resolver.resolve("K2");
  assertEqual(callCount, 2, "シナリオ5b: 認証取得の失敗(null)もメモ化されず、次の呼び出しで再試行される");
}

// ---------------------------------------------------------------------
// 6. キーが違えば以前のURLを返さない(getCachedUrlの取り違え無し)
// ---------------------------------------------------------------------
async function testDifferentKeysNeverShareUrls() {
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => authContext(),
    signUrl: async (k) => signedUrlFor(k),
    storage: makeFakeStorage(),
  });
  await resolver.resolve("keyA");
  assertEqual(resolver.getCachedUrl("keyB"), null, "シナリオ6: 別キーのgetCachedUrlはヒットしない(hookのrender中リセットはReact無しでは実行できないため、ここではresolver側の取り違え無しのみ確認 — 未検証事項として報告する)");
}

// ---------------------------------------------------------------------
// 7. 同キー並列呼び出しは署名1回だけ
// ---------------------------------------------------------------------
async function testConcurrentSameKeyCallsSignOnce() {
  let signUrlCallCount = 0;
  const resolver = new ImageUrlResolver({
    fetchAuthContext: async () => authContext(),
    signUrl: async (k) => {
      signUrlCallCount++;
      await tick(2);
      return signedUrlFor(k);
    },
    storage: makeFakeStorage(),
  });
  const [a, b, c] = await Promise.all([resolver.resolve("K"), resolver.resolve("K"), resolver.resolve("K")]);
  assertEqual(signUrlCallCount, 1, "シナリオ7: 同キーの並列resolve()はsignUrlを1回しか呼ばない");
  assert("url" in a && "url" in b && "url" in c && a.url === b.url && b.url === c.url, "シナリオ7: 3者とも同じ結果を受け取る");
}

// ---------------------------------------------------------------------
// 8. reloadを跨いだ安全な復元(同一identityなら再署名しない)
// ---------------------------------------------------------------------
async function testReloadRestoresWithoutResigning() {
  const storage = makeFakeStorage();
  let signUrlCallCount = 0;
  const fetchAuthContext = async () => authContext({ identityId: "user-a" });
  const signUrl = async (k: string) => {
    signUrlCallCount++;
    return signedUrlFor(k);
  };

  const beforeReload = new ImageUrlResolver({ fetchAuthContext, signUrl, storage });
  await beforeReload.resolve("K");
  assertEqual(signUrlCallCount, 1, "シナリオ8: reload前は署名を1回行う");

  // reload相当: モジュールスコープの状態(=新しいImageUrlResolverインス
  // タンス)は失われるが、同じfakeStorage(sessionStorage相当)とidentity
  // は引き続き有効。
  const afterReload = new ImageUrlResolver({ fetchAuthContext, signUrl, storage });
  const result = await afterReload.resolve("K");
  assertEqual(signUrlCallCount, 1, "シナリオ8: reload後、同一identityならsessionStorageから復元し再署名しない");
  assert("url" in result, "シナリオ8: reload後の結果はurlを含む(stale扱いにならない)");
}

async function main() {
  await testStaleResolveAfterAuthChangeIsNotSavedOrReturned();
  await testAuthChangeWhileWaitingForSlotIsDetected();
  await testPersistedHitFromDifferentIdentityIsRejected();
  await testGuestIdentityNeverPersists();
  await testAuthFetchFailureStillAttemptsSignUrl();
  await testExpiredAuthContextIsRefetchedOnNextCall();
  await testFailedAuthContextIsRetriedOnNextCall();
  await testDifferentKeysNeverShareUrls();
  await testConcurrentSameKeyCallsSignOnce();
  await testReloadRestoresWithoutResigning();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
