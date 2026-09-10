/**
 * app/inventory/inventoryImageUrlCache.ts の純粋ロジック standalone
 * verification(他のverify-*.tsと同じ方針)。
 *
 * この対象モジュールはReact/aws-amplifyに一切依存しないため(意図的な
 * 設計 — see that file's header comment)、実際のuseInventoryImageUrl
 * フック自体(getUrl/fetchAuthSession/Hubに依存)はここでは動かせないが、
 * 今回の変更の核である「同キー同時呼び出しの1本化」「安全な有効期限の
 * 計算(署名URLの期限と資格情報の期限の早い方)」「identity不一致/
 * storage異常時にキャッシュを信用しない」というルールそのものは、この
 * モジュールだけで完結して検証できる。
 *
 * Run with: npm run verify:inventory-image-cache
 */
import {
  InFlightMap,
  PersistentImageUrlCache,
  isFresh,
  isSameIdentity,
  safeExpiryMs,
  type ImageUrlCacheEntry,
  type StorageLike,
} from "@/app/inventory/inventoryImageUrlCache";

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

function entry(overrides: Partial<ImageUrlCacheEntry> = {}): ImageUrlCacheEntry {
  return { url: "https://example.test/signed", expiresAt: Date.now() + 60_000, identityId: "identity-a", ...overrides };
}

// ---------------------------------------------------------------------
// safeExpiryMs / isFresh / isSameIdentity — 期限・identityの判定
// ---------------------------------------------------------------------
function testSafeExpiryMs() {
  const margin = 30_000;
  // 署名URLの期限の方が早い場合はそちらが効く。
  assertEqual(safeExpiryMs(1_000_000, 2_000_000, margin), 1_000_000 - margin, "safeExpiryMs: URL期限の方が早い→URL期限-margin");
  // 資格情報の期限の方が早い場合はそちらが効く(§4「早い方を尊重」の核心)。
  assertEqual(safeExpiryMs(2_000_000, 1_000_000, margin), 1_000_000 - margin, "safeExpiryMs: 資格情報期限の方が早い→資格情報期限-margin");
  // 資格情報の期限が取れない(null)場合はURL期限のみを使う。
  assertEqual(safeExpiryMs(1_000_000, null, margin), 1_000_000 - margin, "safeExpiryMs: 資格情報期限null→URL期限-marginのみ");
}

function testIsFresh() {
  const now = 1_000_000;
  assert(isFresh(entry({ expiresAt: now + 1 }), now), "isFresh: 期限が未来なら新鮮");
  assert(!isFresh(entry({ expiresAt: now }), now), "isFresh: 期限ちょうどは新鮮ではない(境界)");
  assert(!isFresh(entry({ expiresAt: now - 1 }), now), "isFresh: 期限切れは新鮮ではない");
  assert(!isFresh(undefined, now), "isFresh: undefinedは新鮮ではない");
  assert(!isFresh(null, now), "isFresh: nullは新鮮ではない");
}

function testIsSameIdentity() {
  assert(isSameIdentity(entry({ identityId: "identity-a" }), "identity-a"), "isSameIdentity: 同一identityId");
  assert(!isSameIdentity(entry({ identityId: "identity-a" }), "identity-b"), "isSameIdentity: 別identityIdは不一致(ログアウト/ユーザー切替時にキャッシュを信用しない根拠)");
  assert(!isSameIdentity(null, "identity-a"), "isSameIdentity: エントリ無しは不一致");
}

// ---------------------------------------------------------------------
// InFlightMap — 同キー同時呼び出しの1本化(重複getUrl防止)
// ---------------------------------------------------------------------
async function testInFlightMapDedupesConcurrentCalls() {
  const map = new InFlightMap<string>();
  let factoryCalls = 0;
  const factory = () =>
    new Promise<string>((resolve) => {
      factoryCalls++;
      setTimeout(() => resolve("resolved-once"), 5);
    });

  // 「同キー同時mount」相当: 3つの並行呼び出しが同じPromiseに相乗りする。
  const [a, b, c] = await Promise.all([map.run("key1", factory), map.run("key1", factory), map.run("key1", factory)]);
  assertEqual(factoryCalls, 1, "InFlightMap: 同キー同時呼び出しはfactoryを1回しか呼ばない(重複getUrl防止)");
  assertEqual([a, b, c], ["resolved-once", "resolved-once", "resolved-once"], "InFlightMap: 全呼び出し元が同じ結果を受け取る");
  assertEqual(map.size, 0, "InFlightMap: 解決後はin-flightエントリが片付く(次のmountで再利用されない)");
}

async function testInFlightMapAllowsRetryAfterFailure() {
  const map = new InFlightMap<string>();
  let attemptCount = 0;
  const flakyFactory = () => {
    attemptCount++;
    if (attemptCount === 1) return Promise.reject(new Error("network error"));
    return Promise.resolve("ok-second-try");
  };

  // 「失敗リトライ」: 1回目の呼び出しは失敗しても、in-flightエントリは
  // 片付き、2回目の呼び出し(同じキー)は新しくfactoryを走らせられる。
  await map.run("key2", flakyFactory).catch(() => undefined);
  assertEqual(map.size, 0, "InFlightMap: 失敗後もin-flightエントリが残らない");
  const result = await map.run("key2", flakyFactory);
  assertEqual(result, "ok-second-try", "InFlightMap: 失敗後の再呼び出しは新しいfactoryで成功できる(失敗リトライ)");
  assertEqual(attemptCount, 2, "InFlightMap: 失敗後の再試行は本当にfactoryを再実行している(古い失敗を使い回さない)");
}

async function testInFlightMapKeepsDifferentKeysIndependent() {
  const map = new InFlightMap<string>();
  const calls: string[] = [];
  const factoryFor = (key: string) => () => {
    calls.push(key);
    return Promise.resolve(key);
  };
  // 「キー変更時に前画像を表示しない」の下支え: 別キーは別のin-flight
  // エントリとして扱われ、互いの結果を混同しない。
  const [r1, r2] = await Promise.all([map.run("keyA", factoryFor("keyA")), map.run("keyB", factoryFor("keyB"))]);
  assertEqual(r1, "keyA", "InFlightMap: keyAはkeyA自身の結果を受け取る");
  assertEqual(r2, "keyB", "InFlightMap: keyBはkeyB自身の結果を受け取る(別キーが混線しない)");
  assertEqual(calls.sort(), ["keyA", "keyB"], "InFlightMap: 別キーはそれぞれ独立にfactoryが呼ばれる");
}

function testInFlightMapClear() {
  const map = new InFlightMap<string>();
  void map.run("keyX", () => new Promise<string>(() => {})); // 意図的に解決しない(進行中を模す)
  assertEqual(map.size, 1, "InFlightMap: 進行中のエントリが1件ある");
  // ログアウト/ユーザー切替相当。
  map.clear();
  assertEqual(map.size, 0, "InFlightMap: clear()で進行中のエントリも即座に破棄する(ログアウト/ユーザー切替)");
}

// ---------------------------------------------------------------------
// PersistentImageUrlCache — sessionStorage相当。壊れたstorage/異常値も
// 例外を投げずに「キャッシュ無し」へ縮退することを検証する。
// ---------------------------------------------------------------------
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

function testPersistentCacheRoundTrip() {
  const storage = makeFakeStorage();
  const cache = new PersistentImageUrlCache(storage);
  const e = entry();
  cache.set("inventory/photo-1.jpg", e);
  assertEqual(cache.get("inventory/photo-1.jpg"), e, "PersistentImageUrlCache: set直後は同じ値がget()できる");
  assertEqual(cache.get("inventory/other.jpg"), null, "PersistentImageUrlCache: 別キーはヒットしない");
}

function testPersistentCacheSurvivesReload() {
  // reload相当: sessionStorageの中身(fake storage)はそのままに、
  // モジュールスコープの状態(=PersistentImageUrlCacheのインスタンス
  // 自体)だけを作り直す。これはページ再読み込みでJSのメモリ状態が
  // 消えてもsessionStorageは残る、という実ブラウザの挙動を模している。
  const storage = makeFakeStorage();
  const beforeReload = new PersistentImageUrlCache(storage);
  const e = entry({ url: "https://example.test/before-reload" });
  beforeReload.set("inventory/photo-1.jpg", e);

  const afterReload = new PersistentImageUrlCache(storage);
  assertEqual(afterReload.get("inventory/photo-1.jpg"), e, "PersistentImageUrlCache: reload相当(新インスタンス+同じstorage)でも前回のURLを復元できる");
}

function testPersistentCacheHandlesMissingStorage() {
  const cache = new PersistentImageUrlCache(null);
  cache.set("k", entry()); // 例外を投げないこと
  assertEqual(cache.get("k"), null, "PersistentImageUrlCache: storageが無い(null)場合は常にキャッシュ無し扱い、例外を投げない");
}

function testPersistentCacheIgnoresCorruptedEntries() {
  const storage = makeFakeStorage({
    "bello:inventory:imgcache:v1:broken-json": "{not valid json",
    "bello:inventory:imgcache:v1:missing-fields": JSON.stringify({ url: "https://x" }),
    "bello:inventory:imgcache:v1:wrong-types": JSON.stringify({ url: 1, expiresAt: "soon", identityId: 2 }),
  });
  const cache = new PersistentImageUrlCache(storage);
  assertEqual(cache.get("broken-json"), null, "PersistentImageUrlCache: 壊れたJSONは例外を投げずnull(storage壊れ)");
  assertEqual(cache.get("missing-fields"), null, "PersistentImageUrlCache: 必須フィールド欠落はnull");
  assertEqual(cache.get("wrong-types"), null, "PersistentImageUrlCache: 型が不正な値はnull");
}

function testPersistentCacheSurvivesThrowingStorage() {
  const throwingStorage: StorageLike = {
    getItem: () => {
      throw new Error("SecurityError: storage disabled");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("disabled");
    },
    length: 0,
    key: () => {
      throw new Error("disabled");
    },
  };
  const cache = new PersistentImageUrlCache(throwingStorage);
  cache.set("k", entry()); // 例外を投げないこと
  assertEqual(cache.get("k"), null, "PersistentImageUrlCache: getItem/setItemが例外を投げるstorageでも落ちずnull(storage無効)");
  cache.clearAll(); // 例外を投げないこと
  assert(true, "PersistentImageUrlCache: clearAll()もstorageが例外を投げる場合に落ちない");
}

function testPersistentCacheClearAllRemovesOnlyOwnPrefix() {
  const storage = makeFakeStorage({
    "bello:inventory:imgcache:v1:a": JSON.stringify(entry()),
    "bello:inventory:imgcache:v1:b": JSON.stringify(entry()),
    "some-unrelated-app-key": "keep-me",
  });
  const cache = new PersistentImageUrlCache(storage);
  // ログアウト/ユーザー切替相当: 自分の名前空間だけ全件破棄する。
  cache.clearAll();
  assertEqual(cache.get("a"), null, "PersistentImageUrlCache.clearAll: 自分の名前空間のエントリは消える(ログアウト/ユーザー切替)");
  assertEqual(cache.get("b"), null, "PersistentImageUrlCache.clearAll: 複数エントリとも消える");
  assertEqual(storage.getItem("some-unrelated-app-key"), "keep-me", "PersistentImageUrlCache.clearAll: 無関係な他アプリのキーは触らない");
}

function testPersistentCacheIdentityMismatchIsCallerResponsibility() {
  // このモジュール自体はキー単位でしか判断しないため、呼び出し側
  // (useInventoryImageUrl)がisSameIdentity()で照合する必要がある —
  // ここではその契約(get()は生の値をそのまま返すだけ)を明示しておく。
  const storage = makeFakeStorage();
  const cache = new PersistentImageUrlCache(storage);
  const staleEntry = entry({ identityId: "identity-old-user" });
  cache.set("shared-path", staleEntry);
  const raw = cache.get("shared-path");
  assert(raw !== null && !isSameIdentity(raw, "identity-new-user"), "PersistentImageUrlCache + isSameIdentity: 別ユーザーのidentityIdでは不一致と判定できる(呼び出し側がここで弾く)");
}

// ---------------------------------------------------------------------
// hookの「reload後、期限切れなら信用しない」判定を、実際のコンポーネント
// (fetchAuthSession/getUrlに依存)を動かさずに再現する。
// ---------------------------------------------------------------------
function testExpiredPersistedEntryIsRejected() {
  const storage = makeFakeStorage();
  const cache = new PersistentImageUrlCache(storage);
  const now = Date.now();
  const expired = entry({ url: "https://example.test/expired", expiresAt: now - 1, identityId: "identity-a" });
  cache.set("inventory/photo-1.jpg", expired);

  // useInventoryImageUrlのresolveUrl()が実際にやっているのと同じ判定:
  // persisted && isSameIdentity(...) && isFresh(...) の3条件すべてを
  // 満たさない限り、キャッシュされたURLをそのまま使わない。
  const persisted = cache.get("inventory/photo-1.jpg");
  const usable = persisted !== null && isSameIdentity(persisted, "identity-a") && isFresh(persisted, now);
  assert(!usable, "hookの判定ロジック相当: 期限切れのpersistedエントリは(identity一致でも)使われない→getUrlを再度呼ぶ経路に進む");
}

async function main() {
  testSafeExpiryMs();
  testIsFresh();
  testIsSameIdentity();
  await testInFlightMapDedupesConcurrentCalls();
  await testInFlightMapAllowsRetryAfterFailure();
  await testInFlightMapKeepsDifferentKeysIndependent();
  testInFlightMapClear();
  testPersistentCacheRoundTrip();
  testPersistentCacheSurvivesReload();
  testPersistentCacheHandlesMissingStorage();
  testPersistentCacheIgnoresCorruptedEntries();
  testPersistentCacheSurvivesThrowingStorage();
  testPersistentCacheClearAllRemovesOnlyOwnPrefix();
  testPersistentCacheIdentityMismatchIsCallerResponsibility();
  testExpiredPersistedEntryIsRejected();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
