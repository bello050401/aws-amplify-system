/**
 * 出品の状態遷移を固定する検証（**外部APIもDBも使わない**）。
 *
 * ── なぜ先にこれを書くのか ──────────────────────────────────────
 *
 * EC連携ハブ（Next Engine / JUNGLE / 各モール直接API）の選定がまだ
 * 決まっていない。決まった時点で出品まわりを組み替えることになるが、
 * **組み替える前に、いまの振る舞いが何なのかを固定しておかないと、
 * 変えた結果何かが変わっても気づけない。**
 *
 * ここで固定するのはBELLO側の手順だけ。どの出品先にも共通で、ハブが
 * どれになっても変わらない部分に限ってある。
 *
 * ── 期待値の出どころ ────────────────────────────────────────────
 *
 * 抽出前の `listOnMercari` / `listOnBase`（lib/listing/service.ts）の
 * 実装をそのまま読んで書いた。文言・キーの有無・undefinedとnullの
 * 使い分けまで、当時の挙動に一致させてある。
 *
 * Run with: npm run verify:publish-flow
 */
import {
  BASE_ROUTE,
  MERCARI_ROUTE,
  NO_DRAFT_MESSAGE,
  NO_INVENTORY_MESSAGE,
  assertNotAlreadyListed,
  describePublishFailure,
  failedPatch,
  publishedPatch,
  publishingPatch,
  requireChannelListing,
  requireDraft,
  saveFailureMessage,
} from "@/lib/listing/publishFlow";
import type { ChannelListingRecord, ListingDraftRecord } from "@/lib/listing/types";

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
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

function assertThrows(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (err) {
    passes++;
    console.log(`✓ ${label}`);
    return err instanceof Error ? err.message : String(err);
  }
  failures++;
  console.error(`✗ FAIL ${label}\n    expected: 例外, actual: 正常終了`);
  return "";
}

function assertNotThrows(fn: () => unknown, label: string) {
  try {
    fn();
    passes++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`✗ FAIL ${label}\n    予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const NOW = "2026-09-02T12:00:00.000Z";
const EARLIER = "2026-08-01T09:30:00.000Z";

function channelListing(over: Partial<ChannelListingRecord> = {}): ChannelListingRecord {
  return {
    id: "cl-1",
    inventoryId: "inv-1",
    channel: "MERCARI_SHOPS",
    status: "READY",
    externalListingId: null,
    listingUrl: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    firstListedAt: null,
    lastListedAt: null,
    lastError: null,
    ...over,
  } as ChannelListingRecord;
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 出せる状態かどうか（外部APIを叩く前に止める）
 * ══════════════════════════════════════════════════════════════════ */
function testGuards() {
  const msg1 = assertThrows(() => requireDraft(null), "ガード: 下書きが無ければ出品しない");
  assertEqual(msg1, NO_DRAFT_MESSAGE, "ガード: 下書き無しの文言");
  assertNotThrows(() => requireDraft({ id: "d1" } as ListingDraftRecord), "ガード: 下書きがあれば通す");

  const msgM = assertThrows(
    () => requireChannelListing(null, MERCARI_ROUTE),
    "ガード: チャネル設定が無ければ出品しない(Mercari)",
  );
  assertEqual(msgM, "先にMercariのカテゴリー設定を保存してください。", "ガード: Mercari未設定の文言");

  const msgB = assertThrows(
    () => requireChannelListing(null, BASE_ROUTE),
    "ガード: チャネル設定が無ければ出品しない(BASE)",
  );
  assertEqual(msgB, "先にBASEのチャネル設定を保存してください。", "ガード: BASE未設定の文言");

  assertEqual(NO_INVENTORY_MESSAGE, "対象の在庫が見つかりません。", "ガード: 在庫が無いときの文言");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 二重出品を防ぐ
 * ══════════════════════════════════════════════════════════════════
 * 「ACTIVE かつ 外部IDがある」の**両方**が揃ったときだけ出品済みとみなす。
 * 片方だけで止めると、状態だけ進んで実際には出せていない行を
 * 二度と出せなくなる。逆に両方見ないと二重出品する。
 */
function testDuplicateGuard() {
  const listed = channelListing({ status: "ACTIVE", externalListingId: "m-123" });
  const msg = assertThrows(
    () => assertNotAlreadyListed(listed, MERCARI_ROUTE),
    "二重出品: ACTIVE かつ 外部IDありなら止める",
  );
  assertTrue(msg.includes("m-123"), "二重出品: 文言に外部の商品IDを含める(利用者が現物を確認できる)");
  assertTrue(msg.includes("Mercari Shops"), "二重出品: 文言に出品先の名前を含める");
  assertTrue(msg.includes("未対応"), "二重出品: 再出品が未実装であることを伝える");

  const msgB = assertThrows(
    () => assertNotAlreadyListed(channelListing({ status: "ACTIVE", externalListingId: "b-9" }), BASE_ROUTE),
    "二重出品: BASEでも止める",
  );
  assertTrue(msgB.includes("BASE"), "二重出品: BASEの名前が出る");

  // 片方だけなら通す。
  assertNotThrows(
    () => assertNotAlreadyListed(channelListing({ status: "ACTIVE", externalListingId: null }), MERCARI_ROUTE),
    "二重出品: ACTIVEでも外部IDが無ければ出品させる(状態だけ進んだ行を救済)",
  );
  assertNotThrows(
    () => assertNotAlreadyListed(channelListing({ status: "ERROR", externalListingId: "m-1" }), MERCARI_ROUTE),
    "二重出品: 外部IDがあってもERRORなら再試行させる",
  );
  assertNotThrows(
    () => assertNotAlreadyListed(channelListing({ status: "READY" }), MERCARI_ROUTE),
    "二重出品: READY は通す",
  );
  assertNotThrows(
    () => assertNotAlreadyListed(channelListing({ status: "PUBLISHING", externalListingId: "m-1" }), MERCARI_ROUTE),
    "二重出品: PUBLISHING は通す(前回が途中で落ちた行を再試行できる)",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 外部APIを叩く直前 → PUBLISHING
 * ══════════════════════════════════════════════════════════════════
 * ここを残しておかないと、外部API呼び出し中にプロセスが落ちたとき、
 * 「出したのか出していないのか」が後から分からなくなる。
 */
function testPublishing() {
  assertEqual(
    publishingPatch("cl-1", "someone@example.com"),
    { id: "cl-1", status: "PUBLISHING", updatedBy: "someone@example.com" },
    "PUBLISHING: 呼び出し直前に状態を残す",
  );
  assertEqual(
    publishingPatch("cl-1", null),
    { id: "cl-1", status: "PUBLISHING", updatedBy: undefined },
    "PUBLISHING: 実行者が不明なら updatedBy は undefined(空文字で埋めない)",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 成功 → ACTIVE
 * ══════════════════════════════════════════════════════════════════ */
function testPublished() {
  const first = publishedPatch({
    channelListing: channelListing(),
    result: { externalProductId: "m-777" },
    route: MERCARI_ROUTE,
    who: "someone@example.com",
    nowIso: NOW,
  });
  assertEqual(first.status, "ACTIVE", "成功: ACTIVE にする");
  assertEqual(first.externalListingId, "m-777", "成功: 外部の商品IDを保存する");
  assertEqual(first.firstListedAt, NOW, "成功: 初回は firstListedAt に今を入れる");
  assertEqual(first.lastListedAt, NOW, "成功: lastListedAt も今");
  assertEqual(first.lastError, undefined, "成功: 前回のエラーを消す(成功なのにエラー文が残らない)");

  // 2回目。firstListedAt は上書きしない。
  const again = publishedPatch({
    channelListing: channelListing({ firstListedAt: EARLIER }),
    result: { externalProductId: "m-778" },
    route: MERCARI_ROUTE,
    who: null,
    nowIso: NOW,
  });
  assertEqual(again.firstListedAt, EARLIER, "成功: firstListedAt は既にあれば上書きしない(初回日時を失わない)");
  assertEqual(again.lastListedAt, NOW, "成功: lastListedAt は毎回更新する");
  assertEqual(again.updatedBy, undefined, "成功: 実行者が不明なら undefined");

  // listingUrl の扱いは出品先で違う。いまは揃えず、違いを明示している。
  assertTrue("listingUrl" in first, "成功: Mercari は listingUrl を明示的に消す(応答仕様が未確認のため)");
  assertEqual(first.listingUrl, null, "成功: Mercari の listingUrl は null");

  const basePatch = publishedPatch({
    channelListing: channelListing({ channel: "BASE", listingUrl: "https://example.test/item" }),
    result: { externalProductId: "b-1" },
    route: BASE_ROUTE,
    who: null,
    nowIso: NOW,
  });
  assertTrue(
    !("listingUrl" in basePatch),
    "成功: BASE は listingUrl のキー自体を送らない(既存値をそのまま残す)",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 失敗 → ERROR、理由を必ず残す
 * ══════════════════════════════════════════════════════════════════ */
function testFailed() {
  assertEqual(
    failedPatch("cl-1", "在庫数量が0です。", "someone@example.com"),
    { id: "cl-1", status: "ERROR", lastError: "在庫数量が0です。", updatedBy: "someone@example.com" },
    "失敗: ERROR にして理由を残す",
  );
  assertEqual(failedPatch("cl-1", "x", null).updatedBy, undefined, "失敗: 実行者が不明なら undefined");

  // 状態名の取り違えを固定する。FAILED ではなく ERROR。
  assertEqual(failedPatch("cl-1", "x", null).status, "ERROR", "失敗: 状態名は ERROR(FAILED ではない)");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 例外から文言を取り出す
 * ══════════════════════════════════════════════════════════════════
 * 抽出前は `err instanceof MercariApiError ? err.message : err instanceof
 * Error ? err.message : "不明なエラー"` と書かれていた。前2つは同じ値を
 * 返すので、もともとチャネル固有の分岐は無かった。ここではその等価性を
 * 固定する —— 将来ハブを差し替えても、この段は変わらない。
 */
function testDescribeFailure() {
  assertEqual(describePublishFailure(new Error("価格が未設定です。")), "価格が未設定です。", "文言: Error は message を使う");

  class ChannelSpecificError extends Error {}
  assertEqual(
    describePublishFailure(new ChannelSpecificError("レート制限")),
    "レート制限",
    "文言: チャネル固有の例外型でも同じ結果(もともと分岐していなかった)",
  );

  assertEqual(describePublishFailure("ただの文字列"), "不明なエラー", "文言: Error でなければ 不明なエラー");
  assertEqual(describePublishFailure(null), "不明なエラー", "文言: null でも壊れない");
  assertEqual(describePublishFailure(undefined), "不明なエラー", "文言: undefined でも壊れない");
  assertEqual(describePublishFailure({ message: "偽装" }), "不明なエラー", "文言: message を持つだけの物は信用しない");

  // 保存自体の失敗。成功したのに保存できていない状態を黙って通さない。
  assertTrue(
    saveFailureMessage([{ message: "Unauthorized" }]).includes("Unauthorized"),
    "文言: 保存失敗は元のエラーを捨てない",
  );
  assertTrue(saveFailureMessage(undefined).includes("出品結果の保存に失敗"), "文言: errors が無くても保存失敗と分かる");
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 出品先の定義そのもの
 * ══════════════════════════════════════════════════════════════════
 * ハブを差し替えるとき、ここが唯一の接点になる。取り違えると
 * 別チャネルの行を更新してしまうので、値を固定しておく。
 */
function testRoutes() {
  assertEqual(MERCARI_ROUTE.channel, "MERCARI_SHOPS", "経路: Mercari の channel 値");
  assertEqual(BASE_ROUTE.channel, "BASE", "経路: BASE の channel 値");
  assertTrue(MERCARI_ROUTE.channel !== BASE_ROUTE.channel, "経路: channel が重複していない");
  assertEqual(MERCARI_ROUTE.logLabel, "listOnMercari", "経路: ログ接頭辞は既存のまま(Mercari)");
  assertEqual(BASE_ROUTE.logLabel, "listOnBase", "経路: ログ接頭辞は既存のまま(BASE)");
}

testGuards();
testDuplicateGuard();
testPublishing();
testPublished();
testFailed();
testDescribeFailure();
testRoutes();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
