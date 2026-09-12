/**
 * app/inventory/inventoryImageLoadState.ts の standalone verification。
 * 実コンポーネント(InventoryImageGallery.tsx)がそのままimportして
 * 使う判定ロジック(reduceBodyLoadState/planHeroRender/planFullRender)
 * を、React/DOM無しで境界試験する — 2185e57で見つかった不具合
 * (①URL解決だけでloadingが消える、②本体失敗がfullFailedへ反映され
 * ない、③画像切替時に旧画像の遅延イベントが新しい選択へ誤反映する)
 * をそれぞれ固定するテストを含む。
 *
 * Run with: npm run verify:inventory-image-load-state
 */
import {
  initialBodyLoadState,
  reduceBodyLoadState,
  planHeroRender,
  planFullRender,
  type BodyLoadState,
} from "@/app/inventory/inventoryImageLoadState";

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

const idleSmall = (key: string | null): BodyLoadState => initialBodyLoadState(key);

// ---------------------------------------------------------------------
// reduceBodyLoadState — SELECT/LOADED/FAILEDの基本規則
// ---------------------------------------------------------------------
function testSelectResetsState() {
  const loaded = reduceBodyLoadState(idleSmall("a"), { type: "LOADED", key: "a" });
  const reselected = reduceBodyLoadState(loaded, { type: "SELECT", key: "b" });
  assertEqual(reselected, { key: "b", loaded: false, failed: false }, "SELECT: 新しいkeyへ切り替えるとloaded/failedがリセットされる");

  const reopened = reduceBodyLoadState(loaded, { type: "SELECT", key: "a" });
  assertEqual(reopened, { key: "a", loaded: false, failed: false }, "SELECT: 同じkeyへの再SELECT(閉じて開き直す等)でもリセットされる");
}

function testLoadedAndFailedApplyForMatchingKey() {
  const afterLoad = reduceBodyLoadState(idleSmall("k"), { type: "LOADED", key: "k" });
  assertEqual(afterLoad, { key: "k", loaded: true, failed: false }, "LOADED: 現在のkeyと一致すればloaded=trueになる");

  const afterFail = reduceBodyLoadState(idleSmall("k"), { type: "FAILED", key: "k" });
  assertEqual(afterFail, { key: "k", loaded: false, failed: true }, "FAILED: 現在のkeyと一致すればfailed=trueになる");
}

// 完了条件「切替後に旧画像イベントが新選択へ反映しない」の固定テスト。
function testStaleEventsForOldKeyAreIgnored() {
  const afterSwitch = reduceBodyLoadState(idleSmall("photo-1"), { type: "SELECT", key: "photo-2" });
  // photo-1向けのプリロードが遅れてonload/onerrorを発火させた場合を模す。
  const afterStaleLoad = reduceBodyLoadState(afterSwitch, { type: "LOADED", key: "photo-1" });
  assertEqual(afterStaleLoad, afterSwitch, "stale LOADED(旧画像=photo-1)は現在の選択(photo-2)の状態を一切変えない");

  const afterStaleFail = reduceBodyLoadState(afterSwitch, { type: "FAILED", key: "photo-1" });
  assertEqual(afterStaleFail, afterSwitch, "stale FAILED(旧画像=photo-1)は現在の選択(photo-2)の状態を一切変えない");

  // 新しい選択(photo-2)自身のイベントはもちろん反映される。
  const afterFreshLoad = reduceBodyLoadState(afterSwitch, { type: "LOADED", key: "photo-2" });
  assert(afterFreshLoad.loaded, "新しい選択(photo-2)自身のLOADEDは反映される");
}

// ---------------------------------------------------------------------
// planHeroRender — small先行 → medium onLoad成功でのみ差し替え
// ---------------------------------------------------------------------
function testHeroWaitsWhileResolving() {
  const plan = planHeroRender({
    smallUrl: null,
    smallResolveFailed: false,
    smallBody: idleSmall(null),
    mediumUrl: null,
    mediumBody: idleSmall(null),
  });
  assertEqual(plan, { mountSrc: null, showLoadingOverlay: true, showFailedPlaceholder: false }, "hero: URL未解決の間はloading表示のみ(実galleryの初期原本0要求はGallery側がsmallKey/mediumKeyしか渡さないことで保証)");
}

// 完了条件「URL解決時点でloadingが消える」不具合の固定テスト。
function testHeroLoadingPersistsUntilBodyLoadsEvenAfterUrlResolves() {
  const plan = planHeroRender({
    smallUrl: "https://example.test/small.jpg",
    smallResolveFailed: false,
    smallBody: idleSmall("small-key"), // URLは来たが、まだ本体onLoadは発火していない
    mediumUrl: null,
    mediumBody: idleSmall(null),
  });
  assert(plan.mountSrc !== null, "hero: URL解決後は<img>をマウントする(onLoadが発火できるように)");
  assert(plan.showLoadingOverlay, "hero: 本体onLoadがまだ来ていなければ、URLがあってもloadingを消さない");
}

function testHeroShowsSmallUntilMediumBodyLoads() {
  const smallLoaded = reduceBodyLoadState(idleSmall("small-key"), { type: "LOADED", key: "small-key" });
  const planBeforeMediumLoads = planHeroRender({
    smallUrl: "https://example.test/small.jpg",
    smallResolveFailed: false,
    smallBody: smallLoaded,
    mediumUrl: "https://example.test/medium.jpg", // 署名は取れているが、まだ本体onLoadしていない
    mediumBody: idleSmall("medium-key"),
  });
  assertEqual(planBeforeMediumLoads.mountSrc, "https://example.test/small.jpg", "hero: mediumの署名だけでは切り替えない(本体onLoad成功が条件)");
  assert(!planBeforeMediumLoads.showLoadingOverlay, "hero: smallが既に表示できていればloadingは出さない(medium待ちは裏で進む)");

  const mediumLoaded = reduceBodyLoadState(idleSmall("medium-key"), { type: "LOADED", key: "medium-key" });
  const planAfterMediumLoads = planHeroRender({
    smallUrl: "https://example.test/small.jpg",
    smallResolveFailed: false,
    smallBody: smallLoaded,
    mediumUrl: "https://example.test/medium.jpg",
    mediumBody: mediumLoaded,
  });
  assertEqual(planAfterMediumLoads.mountSrc, "https://example.test/medium.jpg", "hero: medium本体のonLoad成功後にだけ差し替える");
}

function testHeroKeepsSmallWhenMediumFails() {
  const smallLoaded = reduceBodyLoadState(idleSmall("small-key"), { type: "LOADED", key: "small-key" });
  const mediumFailed = reduceBodyLoadState(idleSmall("medium-key"), { type: "FAILED", key: "medium-key" });
  const plan = planHeroRender({
    smallUrl: "https://example.test/small.jpg",
    smallResolveFailed: false,
    smallBody: smallLoaded,
    mediumUrl: "https://example.test/medium-broken.jpg",
    mediumBody: mediumFailed,
  });
  assertEqual(plan.mountSrc, "https://example.test/small.jpg", "hero: medium本体が失敗してもsmallを維持する(No Imageに落とさない)");
  assert(!plan.showFailedPlaceholder, "hero: mediumの失敗だけではhero全体をfailed扱いにしない");
}

function testHeroFallsBackToPlaceholderWhenSmallFails() {
  const planResolveFailed = planHeroRender({
    smallUrl: null,
    smallResolveFailed: true,
    smallBody: idleSmall(null),
    mediumUrl: null,
    mediumBody: idleSmall(null),
  });
  assertEqual(planResolveFailed, { mountSrc: null, showLoadingOverlay: false, showFailedPlaceholder: true }, "hero: small自体の署名解決が失敗すればplaceholderへ");

  const smallBodyFailed = reduceBodyLoadState(idleSmall("small-key"), { type: "FAILED", key: "small-key" });
  const planBodyFailed = planHeroRender({
    smallUrl: "https://example.test/small.jpg",
    smallResolveFailed: false,
    smallBody: smallBodyFailed,
    mediumUrl: null,
    mediumBody: idleSmall(null),
  });
  assertEqual(planBodyFailed, { mountSrc: null, showLoadingOverlay: false, showFailedPlaceholder: true }, "hero: 署名は成功したが本体(バイト列)の読み込みが失敗した場合もplaceholderへ(署名成功=表示成功ではない、という完了条件)");
}

// ---------------------------------------------------------------------
// planFullRender — ライトボックス(original)。完了条件「本体失敗が
// fullFailedへ反映されない」不具合の固定テスト。
// ---------------------------------------------------------------------
function testFullWaitsThenShowsOnBodyLoad() {
  const waitingPlan = planFullRender({ fullUrl: null, fullResolveFailed: false, fullBody: idleSmall(null) });
  assertEqual(waitingPlan, { mountSrc: null, showLoadingOverlay: true, showFailedRetry: false }, "full: URL未解決はloadingのみ(拡大時のみ原本要求——galleryがlightboxOpenの間だけキーを渡すことで保証)");

  const resolvedButNotLoadedPlan = planFullRender({ fullUrl: "https://example.test/original.jpg", fullResolveFailed: false, fullBody: idleSmall("orig-key") });
  assert(resolvedButNotLoadedPlan.mountSrc !== null, "full: URL解決後は<img>をマウントする");
  assert(resolvedButNotLoadedPlan.showLoadingOverlay, "full: 本体onLoadが来るまではloadingを維持する(URL解決だけで消さない)");

  const loaded = reduceBodyLoadState(idleSmall("orig-key"), { type: "LOADED", key: "orig-key" });
  const loadedPlan = planFullRender({ fullUrl: "https://example.test/original.jpg", fullResolveFailed: false, fullBody: loaded });
  assertEqual(loadedPlan, { mountSrc: "https://example.test/original.jpg", showLoadingOverlay: false, showFailedRetry: false }, "full: 本体onLoad成功後はloadingを消して画像を表示する");
}

function testFullBodyFailureShowsRetryEvenWhenSigningSucceeded() {
  const bodyFailed = reduceBodyLoadState(idleSmall("orig-key"), { type: "FAILED", key: "orig-key" });
  const plan = planFullRender({
    fullUrl: "https://example.test/original.jpg", // getUrl自体(署名)は成功している
    fullResolveFailed: false, // 署名の失敗ではない
    fullBody: bodyFailed, // ブラウザの実際の画像取得(本体)が失敗した
  });
  assertEqual(plan, { mountSrc: null, showLoadingOverlay: false, showFailedRetry: true }, "full: 署名成功後の本体失敗でも再試行UIが出る(元の不具合: fullFailedにならず再試行が出なかった)");
}

function testFullResolveFailureAlsoShowsRetry() {
  const plan = planFullRender({ fullUrl: null, fullResolveFailed: true, fullBody: idleSmall(null) });
  assertEqual(plan, { mountSrc: null, showLoadingOverlay: false, showFailedRetry: true }, "full: 署名自体の失敗(3回リトライ済み)でも再試行UIが出る(従来通り)");
}

function main() {
  testSelectResetsState();
  testLoadedAndFailedApplyForMatchingKey();
  testStaleEventsForOldKeyAreIgnored();
  testHeroWaitsWhileResolving();
  testHeroLoadingPersistsUntilBodyLoadsEvenAfterUrlResolves();
  testHeroShowsSmallUntilMediumBodyLoads();
  testHeroKeepsSmallWhenMediumFails();
  testHeroFallsBackToPlaceholderWhenSmallFails();
  testFullWaitsThenShowsOnBodyLoad();
  testFullBodyFailureShowsRetryEvenWhenSigningSucceeded();
  testFullResolveFailureAlsoShowsRetry();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
