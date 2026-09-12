/**
 * BELLO統合改修 master指示書 Phase A: standalone (no test framework in
 * this repo — vitest/jest are not installed) unit/integration-style
 * verification for the ZAICO background sync's actual business logic:
 * dedup/create/update/unchanged/failure-isolation via a fully in-memory
 * mock ZaicoSyncPort (no AWS calls at all), the background job's pure
 * checkpoint helpers, and the purchasePrice all-in-原価 profit rule that
 * must survive every phase of this round unchanged.
 *
 * Run with: npm run verify:zaico
 * (must go through scripts/with-server-only-stub.cjs — see that file's
 * comment for why: zaicoSync.ts and its dependencies are marked
 * `server-only`, which throws when `require`d outside Next.js unless
 * that package is temporarily stubbed for this one run.)
 *
 * Exits with a non-zero status if any assertion fails, so it can be
 * wired into CI later without any changes.
 */
import fs from "node:fs";
import path from "node:path";
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";
import { syncOneZaicoItem } from "@/lib/inventory/zaicoSync";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/history";
import { parseSeenSourceIds, toPublicJob } from "@/lib/inventory/zaicoBackgroundSync";
import { syncPendingItemsWithDelta } from "@/lib/inventory/zaicoSyncPageProcessor";
import { summarizeSales, summarizeMonthlyTrend, calculateItemGrossProfit } from "@/lib/inventory/sales";
import { resizeToThumbnailJpeg, resizeToMediumJpeg, THUMBNAIL_MAX_DIMENSION, MEDIUM_MAX_DIMENSION } from "@/lib/inventory/thumbnail";
import { effectiveHeroKey, effectiveListThumbnailKey, type InventoryImageRecord } from "@/lib/inventory/imageTypes";
import { compareByUpdatedAtDesc } from "@/lib/inventory/queries";
import sharp from "sharp";
import type { ZaicoInventory } from "@/lib/zaico/client";

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

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

// ── In-memory mock ZaicoSyncPort ──────────────────────────────────────
// Models exactly the parts of the real serverDataClient-backed adapter
// (zaicoSyncPorts.ts's createServerSyncPort) that syncOneZaicoItem
// actually depends on, without touching AWS: a Map keyed by id acting as
// the "Inventory table", auto-incrementing ids/SKUs, and call counters so
// the tests below can assert e.g. "unchanged never calls createInventory
// /updateInventory" (idempotency) without inspecting private state.
function createMockPort() {
  const store = new Map<string, InventoryModel>();
  const categories = new Map<string, string>();
  const locations = new Map<string, string>();
  const historyLog: { inventoryId: string; who: string | null; changes: HistoryFieldChange[] }[] = [];
  const removedImages: string[] = [];
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: 実DBの
  // ZaicoSourceLinkと同じ「sourceInventoryId → inventoryId」の排他claim
  // をin-memoryで模倣する — claimSourceLink/releaseSourceLinkのテスト
  // (同時実行相当のシナリオを含む)に使う。
  const claimedLinks = new Map<string, string>();
  let nextSkuNum = 1;

  // BELLO ZAICO級高速化仕様書 §30.7: prefetched map / masterCacheが
  // 実際にpore呼び出しを削減していることを検証する(testPrefetchAndMasterCacheAvoidRepeatedLookups)
  // ためのcall counter — findExistingBySourceId/findOrCreateCategory/
  // findOrCreateLocationは全て「呼ばれるたびに高コストなScan相当」を
  // 表す操作なので、この3つの呼び出し回数を数える。
  const calls = {
    createInventory: 0,
    updateInventory: 0,
    generateSku: 0,
    findExistingBySourceId: 0,
    findOrCreateCategory: 0,
    findOrCreateLocation: 0,
    // 2026-09-11 設計見直し: 「未変更商品のために重い処理を省けているか」
    // をDB/画像の呼び出し回数で直接検証するためのcounter。
    // fetchAllZaicoManagedはInventory全件Scan相当、downloadAndImportImage
    // はZAICO画像の取得+S3保存相当——どちらも1件あたりのコストが高い。
    fetchAllZaicoManaged: 0,
    downloadAndImportImage: 0,
  };

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
      calls.findExistingBySourceId++;
      for (const v of store.values()) {
        if (v.sourceInventoryId === sourceInventoryId && !v.deletedAt) return v;
      }
      return null;
    },
    async fetchAllZaicoManaged() {
      calls.fetchAllZaicoManaged++;
      const map = new Map<string, InventoryModel>();
      for (const v of store.values()) {
        if (v.sourceSystem === "ZAICO" && !v.deletedAt && v.sourceInventoryId) map.set(v.sourceInventoryId, v);
      }
      return map;
    },
    async findOrCreateCategory(name: string) {
      calls.findOrCreateCategory++;
      if (categories.has(name)) return { id: categories.get(name)!, created: false };
      const id = `cat-${categories.size + 1}`;
      categories.set(name, id);
      return { id, created: true };
    },
    async findOrCreateLocation(name: string) {
      calls.findOrCreateLocation++;
      if (locations.has(name)) return { id: locations.get(name)!, created: false };
      const id = `loc-${locations.size + 1}`;
      locations.set(name, id);
      return { id, created: true };
    },
    async generateSku() {
      calls.generateSku++;
      return `SKU-${String(nextSkuNum++).padStart(4, "0")}`;
    },
    async createInventory(input: NewInventoryInput) {
      calls.createInventory++;
      // input.idはclaimSourceLinkで既に確保済み(実装と同じ「明示id指定
      // create」規約) — この関数がidを新規発行することはない。
      const record = { ...input } as unknown as InventoryModel;
      store.set(input.id, record);
      return record;
    },
    async claimSourceLink(sourceInventoryId, inventoryId) {
      const existing = claimedLinks.get(sourceInventoryId);
      if (existing !== undefined) return { claimed: false, existingInventoryId: existing };
      claimedLinks.set(sourceInventoryId, inventoryId);
      return { claimed: true };
    },
    async releaseSourceLink(sourceInventoryId) {
      claimedLinks.delete(sourceInventoryId);
    },
    async updateInventory(input: UpdateInventoryInput) {
      calls.updateInventory++;
      const existing = store.get(input.id);
      if (!existing) throw new Error(`mock: no such id ${input.id}`);
      store.set(input.id, { ...existing, ...input } as unknown as InventoryModel);
    },
    async logHistory(inventoryId, who, changes) {
      historyLog.push({ inventoryId, who, changes });
    },
    async downloadAndImportImage(url: string) {
      calls.downloadAndImportImage++;
      return { storageKey: `mock-storage-key-for/${url}`, thumbnailKey: `mock-thumbnail-key-for/${url}`, originalHash: `mock-hash-for/${url}` };
    },
    async removeImage(path: string) {
      removedImages.push(path);
    },
  };

  return { port, store, historyLog, removedImages, calls };
}

function makeZaicoItem(overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: 1001,
    title: "テスト商品A",
    quantity: 3,
    unit: "個",
    category: "家具",
    place: "倉庫A",
    etc: null,
    code: null,
    item_image: null,
    optional_attributes: [
      { name: "⚫︎購入価格", value: "6000" },
      { name: "⚫︎販売価格", value: "12000" },
    ],
    ...overrides,
  } as ZaicoInventory;
}

async function testCreateThenIdempotentUnchanged() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem();

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  assertEqual(first.status, "created", "new ZAICO item syncs as created");
  assertEqual(calls.createInventory, 1, "created exactly one Inventory record");
  assertEqual(store.size, 1, "mock store has exactly one record after first sync");

  // Re-syncing the exact same item (a second `advance` page overlapping,
  // or a re-run after a resumed background job) must find the existing
  // record by sourceInventoryId and treat it as unchanged — never a
  // second create. This is the duplicate-prevention/idempotency
  // requirement from the master instructions, exercised directly.
  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  assertEqual(second.status, "unchanged", "re-syncing the identical item is a no-op (idempotent)");
  assertEqual(calls.createInventory, 1, "re-sync does not call createInventory again");
  assertEqual(calls.updateInventory, 0, "re-sync of an unchanged item does not call updateInventory either");
  assertEqual(store.size, 1, "mock store still has exactly one record (no duplicate created)");
}

async function testUpdateOnRealChange() {
  const { port, calls } = createMockPort();
  const item = makeZaicoItem();
  await syncOneZaicoItem(item, "tester@example.com", undefined, port);

  const changed = makeZaicoItem({ quantity: 7 });
  const result = await syncOneZaicoItem(changed, "tester@example.com", undefined, port);
  assertEqual(result.status, "updated", "a real field change (quantity 3→7) syncs as updated");
  assertEqual(calls.updateInventory, 1, "exactly one updateInventory call for the changed field");
}

async function testFailureIsolation() {
  const { port } = createMockPort();
  const brokenPort: ZaicoSyncPort = {
    ...port,
    async generateSku() {
      throw new Error("mock SKU service unavailable");
    },
  };
  const item = makeZaicoItem({ id: 2002 });
  const result = await syncOneZaicoItem(item, "tester@example.com", undefined, brokenPort);
  assertEqual(result.status, "failed", "a per-item failure is caught and reported, not thrown");
  assertTrue(typeof result.error === "string" && result.error.includes("mock SKU service unavailable"), "failure carries the underlying error message");
}

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.11: 実データで
 * 確認されたZAICO在庫ID重複(例: "50666071")の再発防止テスト。
 * §11.6の同期不変条件(source IDなし→CREATE、あり+変更→UPDATE、
 * あり+同一→SKIP)と§11.7のDB層防止(claimSourceLink)を、10項目の
 * 回帰シナリオとして検証する。
 */
async function testClaimSourceLinkAtomicity() {
  const { port } = createMockPort();
  const first = await port.claimSourceLink("9001", "inv-a");
  assertEqual(first, { claimed: true }, "claimSourceLink: 未claimのsourceInventoryIdは最初のclaimが成功する");

  const second = await port.claimSourceLink("9001", "inv-b");
  assertEqual(second, { claimed: false, existingInventoryId: "inv-a" }, "claimSourceLink: 同じsourceInventoryIdへの2回目のclaimは失敗し、既存の保持者を返す(§11.7 DB層での排他制御)");

  await port.releaseSourceLink("9001");
  const third = await port.claimSourceLink("9001", "inv-c");
  assertEqual(third, { claimed: true }, "claimSourceLink: releaseSourceLink後は再びclaimできる(失敗したcreateの後始末が次の再試行を妨げない)");
}

/**
 * 実際に発見された不具合の核心を直接再現する: `findExistingBySourceId`
 * が(単発list()のスキャン範囲外に落ちる等の理由で)既存レコードを
 * 「見つからない」と誤判定し続けても、`claimSourceLink`によるDB層の
 * 排他制御だけで2件目のInventory作成を防げることを検証する——
 * 「アプリ側の検索ロジックが完全に信用できない最悪のケース」を想定した
 * 防御的テスト(findExistingBySourceIdを常にnullへ固定する)。
 */
async function testRaceDuringSingleItemSyncIsCaughtByClaim() {
  const { port, store, calls } = createMockPort();
  const blindPort: ZaicoSyncPort = {
    ...port,
    async findExistingBySourceId() {
      return null; // 実際の不具合(既存レコードを見逃す)を意図的に再現
    },
  };
  const item = makeZaicoItem({ id: 5001 });

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, blindPort);
  assertEqual(first.status, "created", "重複防止テスト1回目: findExistingBySourceIdが常にnullでも新規作成される");
  assertEqual(calls.createInventory, 1, "重複防止テスト1回目: createInventoryが1回呼ばれる");

  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, blindPort);
  assertEqual(calls.createInventory, 1, "重複防止テスト2回目: findExistingBySourceIdが見逃してもclaimSourceLinkの排他制御でcreateInventoryが2回目呼ばれない(重複防止の核心)");
  assertEqual(store.size, 1, "重複防止テスト2回目の後もInventoryは1件のまま(重複が作られていない)");
  // findExistingBySourceId自体が常にnullを返す設計のこのport variantでは、
  // claim失敗後の再取得もnullになる——「リンクはあるがInventoryが
  // 見つからない」不整合として安全側にfailedを返すのが正しい挙動
  // (無理やり2件目を作ることは絶対にしない、という設計判断の検証)。
  assertEqual(second.status, "failed", "重複防止テスト2回目: ルックアップ自体が壊れている場合は安全側でfailedを返す(強引な重複作成はしない)");
}

/** 同じ防御を、単発同期(prefetched無し)ではなくバッチ/resume経路(prefetchedあり)でも検証する。 */
async function testRaceDuringBatchSyncIsCaughtByClaim() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem({ id: 5002 });

  // resumeが「まだこの商品を見ていない」という(古い/不完全な)prefetched
  // mapを渡すケースを模す——空のMapを渡し続けても、claimSourceLinkが
  // 2回目以降のcreateを防ぐことを確認する。
  const first = await syncOneZaicoItem(item, "tester@example.com", new Map(), port);
  assertEqual(first.status, "created", "resume経路1回目: 空のprefetchedでも新規作成される");
  assertEqual(calls.createInventory, 1, "resume経路1回目: createInventoryが1回呼ばれる");

  const second = await syncOneZaicoItem(item, "tester@example.com", new Map(), port);
  assertEqual(calls.createInventory, 1, "resume経路2回目: 別の空prefetchedでもclaimSourceLinkが重複createを防ぐ");
  assertEqual(store.size, 1, "resume経路2回目の後もInventoryは1件のまま");
  // このport(createMockPort())自体のfindExistingBySourceIdはstore全体を
  // 正しく走査する(実装のO(1) get+完全フォールバックスキャンに相当)ので、
  // claim失敗後の再取得は実際に既存レコードを見つける——内容は1回目と
  // 同一(makeZaicoItemの既定値のまま)なのでunchangedと判定される
  // (failedにもcreatedにもならない=重複が作られていないことの確認)。
  assertEqual(second.status, "unchanged", "resume経路2回目: claim失敗後の再取得で正しく既存レコードが見つかり、unchangedとして扱われる(failedにも新規createにもならない)");
}

/** §11.11 項目8: number/string境界は同一sourceとして扱われる(syncOneZaicoItemのString(zaicoItem.id)正規化の回帰確認)。 */
async function testNumberStringIdBoundaryTreatedAsSameSource() {
  const { port, store, calls } = createMockPort();
  const numericItem = makeZaicoItem({ id: 6001 });
  await syncOneZaicoItem(numericItem, "tester@example.com", undefined, port);
  assertEqual(calls.createInventory, 1, "number形式のidで1件作成");

  const stringItem = makeZaicoItem({ id: "6001" as unknown as number });
  const result = await syncOneZaicoItem(stringItem, "tester@example.com", undefined, port);
  assertEqual(result.status, "unchanged", "number/string境界: 同じ実体を指すidは同一sourceとして扱われ、unchangedになる(重複作成されない)");
  assertEqual(calls.createInventory, 1, "number/string境界: createInventoryは1回のまま増えない");
  assertEqual(store.size, 1, "number/string境界: Inventoryは1件のまま");
}

/** §11.11 項目10: 実例(ZAICO在庫ID"50666071")を象徴的に使い、繰り返し同期しても件数が増えないことを検証する。 */
async function testRepeatedFullResyncNeverIncreasesCount() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem({ id: 50666071 });
  for (let i = 0; i < 5; i++) {
    await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  }
  assertEqual(calls.createInventory, 1, "ZAICO在庫ID50666071相当: 5回同期してもcreateInventoryは最初の1回だけ");
  assertEqual(store.size, 1, "ZAICO在庫ID50666071相当: 5回同期してもInventoryは1件のまま(実データで確認された重複の再発防止)");
}

/** createInventory自体が失敗した場合、claimしたリンクが解放され、次の再試行が「既に誰かが保持している」と誤判定されないことを検証する(§11.8 同時実行/retry)。 */
async function testCreateFailureReleasesClaimForRetry() {
  const { port, store } = createMockPort();
  let shouldFail = true;
  const flakyPort: ZaicoSyncPort = {
    ...port,
    async createInventory(input: NewInventoryInput) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("mock: 一時的な書き込み失敗");
      }
      return port.createInventory(input);
    },
  };
  const item = makeZaicoItem({ id: 7001 });

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, flakyPort);
  assertEqual(first.status, "failed", "retryテスト1回目: createInventory失敗はfailedとして報告される");
  assertEqual(store.size, 0, "retryテスト1回目の後、Inventoryは1件も作られていない");

  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, flakyPort);
  assertEqual(second.status, "created", "retryテスト2回目: releaseSourceLinkにより再試行が正しく新規作成として成功する(失敗したclaimに永久にブロックされない)");
  assertEqual(store.size, 1, "retryテスト2回目の後、Inventoryは正しく1件作成されている");
}

/**
 * 補償処理(releaseSourceLink)自体が失敗した場合の扱い。
 *
 * ## なぜこれを検証するのか
 *
 * create失敗時にclaimを解放できないと、その在庫IDは「リンクはあるが
 * Inventoryが無い」不整合になり、以後の同期で毎回throwされる——つまり
 * **その1件は再同期しても永久に取り込めない**。
 *
 * 実際に 2026-08-31 の全件同期(5,312件)で ZAICO ID 48824174 の1件だけが
 * この状態になり、BELLO側が 5,311件 に留まる原因になっていた。当時の
 * releaseSourceLinkはAmplifyの `errors` を確認せずawaitするだけだったため、
 * 解放の失敗が成功と区別できず、ログにも何も残らなかった。
 *
 * 直したうえで、**元の失敗原因が消えない**ことも確認する。解放の失敗を
 * そのまま投げ直すと、本来の原因(SKU採番失敗、create失敗など)が失われて
 * 調査できなくなるため。
 */
async function testReleaseFailureIsReportedWithoutLosingOriginalError() {
  const { port, store } = createMockPort();
  const flakyPort: ZaicoSyncPort = {
    ...port,
    async createInventory() {
      throw new Error("mock: 一時的な書き込み失敗");
    },
    async releaseSourceLink() {
      throw new Error("mock: リンクの解放にも失敗");
    },
  };

  const result = await syncOneZaicoItem(makeZaicoItem({ id: 48824174 }), "tester@example.com", undefined, flakyPort);
  assertEqual(result.status, "failed", "解放失敗: 結果はfailedとして報告される");
  assertEqual(store.size, 0, "解放失敗: Inventoryは作られていない");

  const message = result.error ?? "";
  assertTrue(
    message.includes("一時的な書き込み失敗"),
    "解放失敗: 元の失敗原因がメッセージに残る(調査できなくならない)",
  );
  assertTrue(
    message.includes("解放"),
    "解放失敗: 解放にも失敗したことがメッセージに出る(黙って不整合を残さない)",
  );
  assertTrue(
    message.includes("手動修復"),
    "解放失敗: 手当てが必要なことが分かる文言になっている",
  );
}

/**
 * ZaicoSyncJob の単一行 id が1箇所でしか定義されていないことを守る。
 *
 * ## なぜこのガードを足したか
 *
 * この値はブラウザ起点の手動advanceとスケジュールLambdaの2つが共有する。
 * 以前は両者がそれぞれ自前のリテラルを持っていて、「どちらが正か」が
 * コード上どこにも書かれていなかった。実際に運用作業中、別のidを指定して
 * **どこからも参照されない ZaicoSyncJob 行を作ってしまう**事故が起きた
 * (2026-08-31)。作られた行は PENDING だったため、放置すればUIが
 * 「同期実行中」と表示し続ける状態でもあった。
 *
 * 値が一致しているかどうかを実行時に比べても意味がない(同じ定数を
 * 見に行くので必ず一致する)。**再びリテラルが書かれていないか**を
 * ソースそのものに対して検査する。
 */
function testSyncJobIdHasSingleDefinition() {
  const SOURCES = [
    "lib/inventory/zaicoBackgroundSync.ts",
    "amplify/functions/zaico-sync-worker/handler.ts",
    "lib/inventory/zaicoSyncJobId.ts",
  ];
  const LITERAL = ZAICO_SYNC_JOB_ID;

  assertTrue(typeof LITERAL === "string" && LITERAL.length > 0, "ジョブID: 定数が空でない");

  const definers: string[] = [];
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    // 文字列リテラルとして直接書かれているか。
    // コメント内でこのidに言及するのは自由にしたいので、コメントは除いてから見る。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const hasLiteral = [`"${LITERAL}"`, `'${LITERAL}'`, `\`${LITERAL}\``].some((q) => code.includes(q));
    if (hasLiteral) definers.push(rel);
  }

  assertEqual(
    definers,
    ["lib/inventory/zaicoSyncJobId.ts"],
    "ジョブID: リテラルの定義はzaicoSyncJobId.tsの1箇所だけ(他所に書き直さない)",
  );

  // 利用側が定数を参照していること
  for (const rel of ["lib/inventory/zaicoBackgroundSync.ts", "amplify/functions/zaico-sync-worker/handler.ts"]) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assertTrue(src.includes("ZAICO_SYNC_JOB_ID"), `ジョブID: ${rel} が共有定数を参照している`);
  }
}

/**
 * 2026-09-11 設計見直しで塞いだ回帰の再発防止ガード:
 * `amplify/functions/zaico-sync-worker/handler.ts`(無人スケジュール
 * Lambda、本番で実際に5分毎に動いている経路)が、差分同期
 * (`syncPendingItemsWithDelta`/`splitByDelta`)を経由せず旧来どおり
 * `seenSourceIds`以外の全件を処理する実装へ**静かに戻っていない**か
 * を、ソースそのものに対して検査する(testSyncJobIdHasSingleDefinition
 * と同じ手法)。
 *
 * 実行時の振る舞いはtestDeltaPageProcessorScenariosで検証済みだが、
 * それは「syncPendingItemsWithDeltaを正しく呼べば正しく動く」ことの
 * 証明であって、「handler.tsが実際にそれを呼んでいる」ことの証明では
 * ない——ここが抜けていた実際の欠陥(このtaskの発端)そのものなので、
 * 両方を別々に守る。
 */
function testHandlerUsesDeltaAwareProcessor() {
  const src = fs.readFileSync(path.join(process.cwd(), "amplify/functions/zaico-sync-worker/handler.ts"), "utf8");
  assertTrue(
    src.includes("zaicoSyncPageProcessor") && src.includes("syncPendingItemsWithDelta"),
    "handler.ts: 無人スケジュールLambdaが共通の差分振り分け(syncPendingItemsWithDelta)を実際に呼んでいる",
  );
  assertTrue(
    src.includes("resolveNextSyncBasis"),
    "handler.ts: 完了時の基準更新が部分失敗を考慮するresolveNextSyncBasis経由になっている(素のnextSuccessfulSyncAt直呼びへ後退していない)",
  );
}

/**
 * 2026-09-12 追記: 「BELLO未取込+古いupdated_atの商品が永久にskipされ
 * 続ける」不具合(lib/inventory/zaicoDelta.tsのsplitByDeltaコメント
 * 参照)の再発防止ガード。この不具合を塞いだ設計は2つの静的事実に
 * 依存している——どちらか片方でも崩れると、実行時テスト
 * (testDeltaPageProcessorScenariosのシナリオ7)を通さない限り気づけない
 * ため、ソースそのものへの検査として別途固定する。
 *
 *   1. `zaicoSyncPageProcessor.ts`自身は`fetchAllZaicoManaged`を呼ばない
 *      ——呼び出し元(handler.ts)が渡した`existingBySourceId`だけを使う。
 *      ここでpage単位の独自fetchが復活すると、「対象0件のページでは
 *      Scanしない」という旧最適化(=時刻だけでskip候補になった商品の
 *      実在確認をしない)が静かに戻る。
 *   2. `handler.ts`は`fetchAllZaicoManaged`をページを回す`for`ループの
 *      **外側で1回だけ**呼ぶ——ループの中に戻ると、1 invocationあたり
 *      「変更ありページの数」だけScanが増える2026-09-11版の非効率に
 *      戻ってしまう(取りこぼしは起きないが、このtaskの高速化の主眼に
 *      反する)。
 *
 * 2026-09-12 task_1606b70追記: `fetchAllZaicoManaged`はtry**の内側**で
 * 呼ばれていること(loop外の1回目の呼び出し自体も含む)も併せて検査する。
 * try**の外**で呼んでいた回帰(task_a320で発見・修正)は、prefetch自体が
 * 例外を投げたときにcatch(retryCount記録)にもfinally(releaseLease)にも
 * 到達させない——lease/retry状態を隠したまま関数が終わってしまう。
 * 実行時側は`testHandlerBoundaryScenarios`の「prefetch例外」シナリオで
 * 別途固定している。
 */
function testHandlerFetchesExistingSetOncePerInvocation() {
  const processorSrc = fs.readFileSync(path.join(process.cwd(), "lib/inventory/zaicoSyncPageProcessor.ts"), "utf8");
  const processorCode = processorSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertTrue(
    !processorCode.includes("fetchAllZaicoManaged"),
    "zaicoSyncPageProcessor.ts: fetchAllZaicoManagedを自分では呼ばない(呼び出し元が渡すexistingBySourceIdだけを使う)",
  );

  const handlerSrc = fs.readFileSync(path.join(process.cwd(), "amplify/functions/zaico-sync-worker/handler.ts"), "utf8");
  // コメント内の言及(バッククォート付き引用等)を実際の呼び出しと
  // 混同しないよう、コメントを除いてから検査する(testSyncJobIdHasSingleDefinitionと同じ手法)。
  const handlerCode = handlerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const fetchIdx = handlerCode.indexOf("port.fetchAllZaicoManaged()");
  const loopIdx = handlerCode.indexOf("for (;;)");
  const tryIdx = handlerCode.indexOf("try {");
  assertTrue(fetchIdx >= 0, "handler.ts: port.fetchAllZaicoManagedを呼んでいる");
  assertTrue(loopIdx >= 0, "handler.ts: ページを回すforループが存在する");
  assertTrue(tryIdx >= 0, "handler.ts: try節が存在する");
  assertTrue(
    fetchIdx >= 0 && loopIdx >= 0 && fetchIdx < loopIdx,
    "handler.ts: fetchAllZaicoManagedはページloopの外側(=invocationにつき1回)で呼ばれている",
  );
  assertTrue(
    tryIdx >= 0 && fetchIdx >= 0 && tryIdx < fetchIdx,
    "handler.ts: fetchAllZaicoManagedはtryブロックの内側で呼ばれている(外側で呼ぶと例外時にretry記録/finally releaseLeaseを通らない — task_a320で発見・修正)",
  );
  const occurrences = handlerCode.split("port.fetchAllZaicoManaged()").length - 1;
  assertEqual(occurrences, 1, "handler.ts: port.fetchAllZaicoManagedの呼び出し箇所は1つだけ(ページ毎に増えていない)");
}

/**
 * BELLO ZAICO級高速化仕様書 §30.7: baseline計測(scripts/
 * benchmark-zaico-sync.ts)で確定した2つのN+1(sourceInventoryIdの
 * 全件Scan、Category/Locationマスタの全件取得)がprefetched map /
 * masterCacheで実際に回避されることを、呼び出し回数レベルで検証する
 * ——ミリ秒の計測ではなく「該当port関数が呼ばれた回数」という決定論的
 * な指標でのregressionテスト。
 */
async function testPrefetchAndMasterCacheAvoidRepeatedLookups() {
  const { port, calls } = createMockPort();
  // 3件、同じカテゴリ/場所名を共有する既存ZAICO商品を用意。
  for (const id of [3001, 3002, 3003]) {
    await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", undefined, port);
  }
  const createCalls = { ...calls };
  assertEqual(createCalls.findOrCreateCategory, 3, "前提: prefetch無しの初回作成では商品ごとにfindOrCreateCategoryが呼ばれる");

  // prefetched mapを渡さない(従来のadvanceZaicoBackgroundSyncJobの実際
  // にあったバグを再現)場合: 3件とも変更無しでもfindExistingBySourceId
  // が3回呼ばれ、masterCache無しなのでfindOrCreateCategory/Locationも
  // それぞれ3回追加で呼ばれる。
  const beforeFix = { ...calls };
  for (const id of [3001, 3002, 3003]) {
    await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", undefined, port);
  }
  assertEqual(calls.findExistingBySourceId - beforeFix.findExistingBySourceId, 3, "prefetch無し: 3件のunchanged再同期でfindExistingBySourceIdが3回呼ばれる(修正前の実装)");
  assertEqual(calls.findOrCreateCategory - beforeFix.findOrCreateCategory, 3, "prefetch無し: masterCache無しでは3件ともfindOrCreateCategoryを呼ぶ");

  // 修正後: 1ページ分としてprefetched map + masterCacheを1回だけ用意し、
  // 3件全てに使い回す。
  const prefetched = await port.fetchAllZaicoManaged();
  const masterCache = { categories: new Map<string, { id: string }>(), locations: new Map<string, { id: string }>() };
  const afterFixStart = { ...calls };
  for (const id of [3001, 3002, 3003]) {
    const result = await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", prefetched, port, masterCache);
    assertEqual(result.status, "unchanged", `修正後: id=${id}は正しくunchanged判定される(prefetch/cacheの有無が判定結果自体を変えない)`);
  }
  assertEqual(calls.findExistingBySourceId - afterFixStart.findExistingBySourceId, 0, "修正後: prefetched mapがあるのでfindExistingBySourceIdは1回も呼ばれない");
  assertEqual(calls.findOrCreateCategory - afterFixStart.findOrCreateCategory, 1, "修正後: masterCacheにより同じカテゴリ名の3件でfindOrCreateCategoryは初出の1回だけ");
  assertEqual(calls.findOrCreateLocation - afterFixStart.findOrCreateLocation, 1, "修正後: masterCacheにより同じ場所名の3件でfindOrCreateLocationは初出の1回だけ");
}

/**
 * 2026-09-11 設計見直し→2026-09-12 追記: lib/inventory/
 * zaicoSyncPageProcessor.tsのsyncPendingItemsWithDelta(handler.ts=
 * 無人スケジュールLambda側が使う差分振り分け)を、実worker関数
 * (syncOneZaicoItem)自体は差し替えずport層だけをmockして検証する。
 *
 * 2026-09-12: `existingBySourceId`は呼び出し元(このテストではhandler.ts
 * を模して、テスト自身)が**invocationにつき1回だけ**`port.
 * fetchAllZaicoManaged()`した結果を渡す設計に変わった——関数自体は
 * 二度とこれを呼ばない(testHandlerFetchesExistingSetOncePerInvocation
 * の静的ガードと対になる実行時側の確認)。
 *
 * タスクの完了条件(「変更20件時の処理量削減証拠」)に対応: 5,000件中
 * 20件だけ更新のシナリオで、DB呼び出し(findOrCreateCategory/Location)
 * と画像呼び出し(downloadAndImportImage)が「実際に処理した20件相当」
 * でしか増えないことを、呼び出し回数という決定論的な指標で確認する
 * ——ミリ秒計測は環境依存であてにならないため、ここでは行わない
 * (実測はscripts/benchmark-zaico-sync.ts / QAの実画面確認に委ねる。
 * 詳細はdocs/zaico-sync-delta-redesign-*.md)。
 */
async function testDeltaPageProcessorScenarios() {
  const since = "2026-09-01T00:00:00.000Z";
  const BEFORE_SINCE = "2026-08-01T00:00:00.000Z"; // sinceより古い = 前回以降未変更として扱われるべき
  const AFTER_SINCE = "2026-09-05T00:00:00.000Z"; // sinceより新しい = 今回変更されたとして扱われるべき
  const TOTAL = 5000;
  const UPDATED_COUNT = 20;

  const baseline = (id: number) => makeZaicoItem({ id, title: `商品${id}`, category: "家具", place: "倉庫A", updated_at: BEFORE_SINCE });

  async function seed(port: ZaicoSyncPort): Promise<void> {
    for (let id = 1; id <= TOTAL; id++) await syncOneZaicoItem(baseline(id), "seed", undefined, port);
  }

  // ── シナリオ1: 5,000件中20件だけ更新 ──────────────────────────────
  {
    const { port, calls } = createMockPort();
    await seed(port);
    const before = { ...calls };

    // handler.tsを模して、このinvocationにつき1回だけprefetchする。
    const existingBySourceId = await port.fetchAllZaicoManaged();
    assertEqual(calls.fetchAllZaicoManaged - before.fetchAllZaicoManaged, 1, "20件更新: このテスト自身のprefetchが1回カウントされる(前提確認)");
    const afterPrefetch = { ...calls };

    const pending = Array.from({ length: TOTAL }, (_, i) => {
      const id = i + 1;
      return id <= UPDATED_COUNT ? makeZaicoItem({ id, title: `商品${id}`, category: "家具", place: "倉庫A", quantity: 999, updated_at: AFTER_SINCE }) : baseline(id);
    });

    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", port, () => false, existingBySourceId);

    assertEqual(outcome.counts.skippedByDelta, TOTAL - UPDATED_COUNT, "20件更新: 未変更の残り4,980件は差分スキップされる");
    assertEqual(outcome.counts.totalProcessed, UPDATED_COUNT, "20件更新: 実処理は更新分の20件だけ");
    assertEqual(outcome.counts.updated, UPDATED_COUNT, "20件更新: 20件とも updated 判定になる");
    assertEqual(outcome.counts.failed, 0, "20件更新: 失敗は無い");
    assertEqual(outcome.observedSourceIds.length, TOTAL, "20件更新: 観測済みは処理分+スキップ分で5,000件全部(取りこぼしが無いことの直接確認)");
    assertEqual(calls.fetchAllZaicoManaged - afterPrefetch.fetchAllZaicoManaged, 0, "20件更新: syncPendingItemsWithDelta自体は追加のfetchAllZaicoManagedを一切呼ばない(渡されたexistingBySourceIdだけを使う)");
    assertEqual(calls.updateInventory - afterPrefetch.updateInventory, UPDATED_COUNT, "20件更新: DynamoDB書き込みは実際に変わった20件だけ(残り4,980件へは書かない)");
    // masterCacheはsyncPendingItemsWithDeltaの呼び出し単位(=1ページ)で
    // 新規に作られる(前のシード書き込みの記憶は持たない)ため、この
    // 呼び出し内で初めて見るカテゴリ名は最初の1件だけcache miss になる
    // ——残り19件はそのcache hitで賄われ、20件のために20回にはならない。
    assertEqual(
      calls.findOrCreateCategory - afterPrefetch.findOrCreateCategory,
      1,
      "20件更新: masterCacheが1ページ内で使い回されるので、20件同じカテゴリ名でもfindOrCreateCategoryは初出の1回だけ",
    );
    assertEqual(calls.downloadAndImportImage - afterPrefetch.downloadAndImportImage, 0, "20件更新: どの更新もitem_imageを変えていないので画像取得は0回");
  }

  // ── シナリオ2: 5,000件中0件変更(全未変更)、かつ複数ページ相当 ────────
  // 2026-09-12: 「対象0件のページではfetchAllZaicoManagedを呼ばない」
  // という旧最適化(呼ばない=時刻だけでskip判定)は、BELLO未取込の
  // 取りこぼしを防ぐために廃止した。代わりに「invocation全体で
  // 高々1回」を、複数ページ相当の呼び出しをまたいで検証する。
  {
    const { port, calls } = createMockPort();
    await seed(port);
    const before = { ...calls };
    const existingBySourceId = await port.fetchAllZaicoManaged();
    const afterPrefetch = { ...calls };

    const PAGE_SIZE = 50;
    const pages = Math.ceil(TOTAL / PAGE_SIZE);
    let totalProcessed = 0;
    let totalSkipped = 0;
    for (let p = 0; p < pages; p++) {
      const pagePending = Array.from({ length: PAGE_SIZE }, (_, i) => baseline(p * PAGE_SIZE + i + 1)).filter((_, i) => p * PAGE_SIZE + i < TOTAL);
      const outcome = await syncPendingItemsWithDelta(pagePending, since, "tester@example.com", port, () => false, existingBySourceId);
      totalProcessed += outcome.counts.totalProcessed;
      totalSkipped += outcome.counts.skippedByDelta;
    }

    assertEqual(totalSkipped, TOTAL, "全未変更: 5,000件とも差分スキップ(複数ページ相当の合計)");
    assertEqual(totalProcessed, 0, "全未変更: 実処理0件");
    assertEqual(
      calls.fetchAllZaicoManaged - afterPrefetch.fetchAllZaicoManaged,
      0,
      "全未変更: ページ相当を何回呼んでもsyncPendingItemsWithDelta自体はfetchAllZaicoManagedを1回も追加で呼ばない(invocationにつき1回のprefetchで足りる)",
    );
    assertEqual(calls.updateInventory - afterPrefetch.updateInventory, 0, "全未変更: DynamoDBへの書き込みが1件も無い");
    assertEqual(calls.downloadAndImportImage - afterPrefetch.downloadAndImportImage, 0, "全未変更: 画像取得も1件も無い");
  }

  // ── シナリオ3: 5,000件中5,000件変更(全件変更) ────────────────────
  {
    const { port, calls } = createMockPort();
    await seed(port);
    const existingBySourceId = await port.fetchAllZaicoManaged();
    const before = { ...calls };
    const pending = Array.from({ length: TOTAL }, (_, i) => makeZaicoItem({ id: i + 1, category: "家具", place: "倉庫A", quantity: 999, updated_at: AFTER_SINCE }));

    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", port, () => false, existingBySourceId);

    assertEqual(outcome.counts.skippedByDelta, 0, "全件変更: 何もスキップしない(取りこぼし方向には倒れない)");
    assertEqual(outcome.counts.totalProcessed, TOTAL, "全件変更: 5,000件全部処理する");
    assertEqual(outcome.counts.updated, TOTAL, "全件変更: 5,000件全部updated");
    assertEqual(calls.fetchAllZaicoManaged - before.fetchAllZaicoManaged, 0, "全件変更: それでも追加のfetchAllZaicoManagedは0回(既に渡されたexistingBySourceIdだけで足りる)");
    assertEqual(calls.updateInventory - before.updateInventory, TOTAL, "全件変更: 5,000件全部書き込む");
  }

  // ── シナリオ4: updated_at不明の商品は判断できないので必ず処理する ──
  {
    const { port } = createMockPort();
    const existingBySourceId = await port.fetchAllZaicoManaged();
    const pending = [makeZaicoItem({ id: 99001, category: "家具", place: "倉庫A", updated_at: null, created_at: null })];
    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", port, () => false, existingBySourceId);
    assertEqual(outcome.counts.skippedByDelta, 0, "日時不明: 差分スキップしない(needsSyncの「判断できないものはやる」を経由)");
    assertEqual(outcome.counts.totalProcessed, 1, "日時不明: 実処理される");
  }

  // ── シナリオ5: 部分失敗——失敗した商品も観測済みにはなるが、次回の
  //     再試行可否はresolveNextSyncBasis(呼び出し元)側の責務。ここでは
  //     「失敗してもページ処理自体は止まらず、failedとして数えられる」
  //     ことだけを確認する。
  {
    const { port } = createMockPort();
    const existingBySourceId = await port.fetchAllZaicoManaged();
    const brokenPort: ZaicoSyncPort = {
      ...port,
      async generateSku() {
        throw new Error("mock: SKU発番に失敗(新規作成時のみ発生する障害を模す)");
      },
    };
    const pending = [makeZaicoItem({ id: 99101, category: "家具", place: "倉庫A", updated_at: AFTER_SINCE })]; // DBに無い新規商品 → createInventory経路 → generateSkuで失敗
    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", brokenPort, () => false, existingBySourceId);
    assertEqual(outcome.counts.failed, 1, "部分失敗: 1件のgenerateSku失敗はfailedとして数えられる(例外で全体を止めない)");
    assertEqual(outcome.observedSourceIds.length, 1, "部分失敗: 失敗した商品もこのページでは観測済みに入る(seenSourceIdsが二重処理しないため)");
  }

  // ── シナリオ6: ページの途中で時間切れ ────────────────────────────
  {
    const { port } = createMockPort();
    const existingBySourceId = await port.fetchAllZaicoManaged();
    const pending = Array.from({ length: 5 }, (_, i) => makeZaicoItem({ id: 99201 + i, category: "家具", place: "倉庫A", updated_at: AFTER_SINCE }));
    // isBudgetExhaustedはtoProcessの各itemを処理する直前に1回ずつ呼ばれる
    // (zaicoSyncPageProcessor.ts参照)。呼び出し回数自体をカウントして、
    // 2件処理した時点で時間切れになる状況を模す。
    let checks = 0;
    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", port, () => {
      checks += 1;
      return checks > 2;
    }, existingBySourceId);
    assertEqual(outcome.budgetExhausted, true, "時間切れ: budgetExhaustedがtrueになる");
    assertEqual(outcome.counts.totalProcessed, 2, "時間切れ: 5件のうち2件だけ処理され、残りは次回のhandler呼び出しが同じページを取り直して続ける");
  }

  // ── シナリオ7(2026-09-12追記): BELLO未取込+ZAICO側updated_atが古い ──
  // このtaskの発端そのもの。何らかの理由でBELLOに一度も取り込まれて
  // いない商品(=existingBySourceIdに無い)が、ZAICO側のupdated_atだけ
  // `since`より古い場合、時刻だけで判定すると永久にskipされる
  // (lib/inventory/zaicoDelta.tsのsplitByDeltaコメント参照)。
  // existingBySourceIdによる実在確認で、古い時刻でも正しく処理側へ
  // 回ることを確認する。
  {
    const { port, store, calls } = createMockPort();
    // 通常のZAICO商品を先に取り込んでおく(existingBySourceIdに実在する対照群)。
    await syncOneZaicoItem(baseline(1), "seed", undefined, port);
    // id=2はBELLOへ一度も取り込まれていない(storeに無い)まま、
    // ZAICO側のupdated_atだけが`since`より古い状態を模す。
    const staleButMissing = makeZaicoItem({ id: 2, title: "取り込み漏れ商品", category: "家具", place: "倉庫A", updated_at: BEFORE_SINCE });

    const existingBySourceId = await port.fetchAllZaicoManaged();
    assertEqual(existingBySourceId.has("2"), false, "前提: id=2はBELLOにまだ存在しない");

    const pending = [baseline(1), staleButMissing];
    const before = { ...calls };
    const outcome = await syncPendingItemsWithDelta(pending, since, "tester@example.com", port, () => false, existingBySourceId);

    assertEqual(outcome.counts.skippedByDelta, 1, "取りこぼし防止: BELLOに実在するid=1だけがskipされる");
    assertEqual(outcome.counts.totalProcessed, 1, "取りこぼし防止: BELLO未取込のid=2(古い時刻)は時刻だけでskipされず処理される");
    assertEqual(outcome.counts.created, 1, "取りこぼし防止: id=2は新規作成として処理される");
    assertEqual(outcome.observedSourceIds.sort(), ["1", "2"], "取りこぼし防止: 両方とも観測済みになる(削除検出の誤検出を防ぐ)");
    const createdForId2 = Array.from(store.values()).some((v) => v.sourceInventoryId === "2");
    assertTrue(createdForId2, "取りこぼし防止: id=2が実際にInventoryへ作成されている");
    assertEqual(calls.createInventory - before.createInventory, 1, "取りこぼし防止: createInventoryが実際に1回呼ばれている");
  }
}

function testBackgroundJobPureHelpers() {
  assertEqual(Array.from(parseSeenSourceIds(["a", "b", "a", 3, null])).sort(), ["a", "b"], "parseSeenSourceIds dedups and drops non-string entries");
  assertEqual(Array.from(parseSeenSourceIds(undefined)), [], "parseSeenSourceIds tolerates a missing/undefined value");
  // 2026-08-29統合改修版 §6.4: 実際に報告された `Variable 'seenSourceIds'
  // has an invalid value.` の回帰テスト — 書き込み側が常にJSON文字列化
  // するようになった(stringifySeenSourceIds)後も、読み取り側がその
  // 文字列を正しく複合できることを確認する。
  assertEqual(Array.from(parseSeenSourceIds(JSON.stringify(["x", "y", "x"]))).sort(), ["x", "y"], "parseSeenSourceIds parses the JSON string form (what write side now always produces)");
  assertEqual(Array.from(parseSeenSourceIds("not valid json")), [], "parseSeenSourceIds degrades to empty on unparseable garbage instead of throwing");

  const job = toPublicJob({
    status: "RUNNING",
    lastPage: 3,
    totalProcessed: 120,
    created: 10,
    updated: 5,
    unchanged: 100,
    failed: 5,
    imageImported: 8,
    missingSourceIds: ["x", null, "y"],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    finishedAt: null,
    lastError: null,
    triggeredBy: "admin@example.com",
  });
  assertEqual(job.missingSourceIds, ["x", "y"], "toPublicJob filters out null entries from missingSourceIds");
  assertEqual(job.updatedAt, null, "toPublicJob defaults a missing optional field to null, not undefined");
  assertEqual(job.lastPage, 3, "toPublicJob passes through checkpoint fields unchanged");
}

function testPurchasePriceAllInCostRule() {
  // The exact regression case named in the master instructions:
  // sales=100000, purchasePrice=60000, legacy shippingCost=10000
  // → cost must be 60000 (purchasePrice only), profit must be 40000.
  // shippingCost must NEVER be re-added on top of purchasePrice.
  const summary = summarizeSales(
    [
      {
        id: "inv-1",
        displayId: "0001",
        sku: "SKU-0001",
        name: "テスト商品",
        saleEndDate: "2026-03-15",
        salePrice: 100000,
        purchasePrice: 60000,
        shippingCost: 10000,
      },
    ],
    2026,
    3,
  );
  assertEqual(summary.totalSales, 100000, "purchasePrice rule: totalSales");
  assertEqual(summary.totalCost, 60000, "purchasePrice rule: totalCost = purchasePrice only (shippingCost excluded)");
  assertEqual(summary.totalProfit, 40000, "purchasePrice rule: totalProfit = sales - purchasePrice-only cost");
}

// BELLO統合改修 master指示書(2026-08-29統合改修版) §20/§21 —
// 12ヶ月推移グラフの中央集計ロジック(summarizeMonthlyTrend)と、商品
// 単位の粗利益(calculateItemGrossProfit)。 ───────────────────────────

function testCalculateItemGrossProfit() {
  assertEqual(calculateItemGrossProfit(10000, 6000), 4000, "calculateItemGrossProfit: salePrice - purchasePrice");
  assertEqual(calculateItemGrossProfit(null, 6000), -6000, "calculateItemGrossProfit: treats a missing salePrice as 0");
  assertEqual(calculateItemGrossProfit(10000, null), 10000, "calculateItemGrossProfit: treats a missing purchasePrice as 0");
}

function testSummarizeMonthlyTrend() {
  const records = [
    { id: "a", displayId: "0001", sku: "SKU-0001", name: "3月商品", saleEndDate: "2026-03-10", salePrice: 5000, purchasePrice: 2000, shippingCost: 0 },
    { id: "b", displayId: "0002", sku: "SKU-0002", name: "1月商品", saleEndDate: "2026-01-05", salePrice: 3000, purchasePrice: 1000, shippingCost: 0 },
  ];
  const points = summarizeMonthlyTrend(records, 2026, 3, 12);
  assertEqual(points.length, 12, "summarizeMonthlyTrend: always returns exactly monthsBack points");
  assertEqual(points[points.length - 1], { year: 2026, month: 3, totalSales: 5000, totalGrossProfit: 3000 }, "summarizeMonthlyTrend: last point is the end month itself");
  assertEqual(points[9], { year: 2026, month: 1, totalSales: 3000, totalGrossProfit: 2000 }, "summarizeMonthlyTrend: an earlier month with real sales is included, not just the end month");
  // 実績が無い月(2026年2月)も0埋めで含まれる(欠番にならない) — spec:
  // 「実績が無い月も0として表示、月が飛ばない」。
  assertEqual(points[10], { year: 2026, month: 2, totalSales: 0, totalGrossProfit: 0 }, "summarizeMonthlyTrend: a month with zero matching sales is zero-filled, not skipped");
  // 年をまたぐ(2025年4月〜2026年3月の12ヶ月)ことも確認 — shiftYearMonth
  // 経由で年境界を正しく扱えているかの回帰確認。
  assertEqual(points[0], { year: 2025, month: 4, totalSales: 0, totalGrossProfit: 0 }, "summarizeMonthlyTrend: the oldest point correctly crosses the year boundary");
}

async function testThumbnailResize() {
  // A synthetic 1000×600 image (well past THUMBNAIL_MAX_DIMENSION on its
  // long edge) — sharp can synthesize raw pixel data directly, so this
  // needs no fixture file checked into the repo.
  const large = await sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 200, g: 80, b: 80 } } })
    .jpeg()
    .toBuffer();
  const resized = await resizeToThumbnailJpeg(large);
  const meta = await sharp(resized).metadata();
  assertTrue((meta.width ?? 0) <= THUMBNAIL_MAX_DIMENSION, "thumbnail resize: width is capped at THUMBNAIL_MAX_DIMENSION");
  assertTrue((meta.height ?? 0) <= THUMBNAIL_MAX_DIMENSION, "thumbnail resize: height is capped at THUMBNAIL_MAX_DIMENSION");
  assertEqual(meta.format, "jpeg", "thumbnail resize: output format is JPEG");
  assertTrue(resized.length < large.length, "thumbnail resize: output is smaller than the original (the whole point)");

  // A source already smaller than the cap must never be upscaled
  // (withoutEnlargement) — master指示書 Phase B優先度5 territory: don't
  // do wasted/harmful work on an image that's already small.
  const small = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();
  const resizedSmall = await resizeToThumbnailJpeg(small);
  const smallMeta = await sharp(resizedSmall).metadata();
  assertEqual(smallMeta.width, 100, "thumbnail resize: a source already smaller than the cap is never upscaled (width)");
  assertEqual(smallMeta.height, 60, "thumbnail resize: a source already smaller than the cap is never upscaled (height)");
}

async function testMediumResize() {
  // 画像表示高速化・段階読込(P1) — resizeToMediumJpegはresizeToThumbnailJpeg
  // と全く同じresizeJpeg実装を共有するので、ここでは「thumbnailと違う
  // 定数(MEDIUM_MAX_DIMENSION)が実際に効いているか」だけを確認する
  // (EXIF回転・fit:inside・never-upscaleの回帰はtestThumbnailResizeが
  // 既に見ている——同じ共有関数なのでここで重複させない)。
  const large = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 80, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
  const resized = await resizeToMediumJpeg(large);
  const meta = await sharp(resized).metadata();
  assertTrue((meta.width ?? 0) <= MEDIUM_MAX_DIMENSION, "medium resize: width is capped at MEDIUM_MAX_DIMENSION");
  assertTrue((meta.height ?? 0) <= MEDIUM_MAX_DIMENSION, "medium resize: height is capped at MEDIUM_MAX_DIMENSION");
  assertTrue(MEDIUM_MAX_DIMENSION > THUMBNAIL_MAX_DIMENSION, "medium resize: MEDIUM_MAX_DIMENSION is meaningfully larger than THUMBNAIL_MAX_DIMENSION");
  assertEqual(meta.format, "jpeg", "medium resize: output format is JPEG");
  assertTrue(resized.length < large.length, "medium resize: output is smaller than the original");

  const small = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();
  const resizedSmall = await resizeToMediumJpeg(small);
  const smallMeta = await sharp(resizedSmall).metadata();
  assertEqual(smallMeta.width, 100, "medium resize: a source already smaller than the cap is never upscaled (width)");
  assertEqual(smallMeta.height, 60, "medium resize: a source already smaller than the cap is never upscaled (height)");
}

function testEffectiveHeroKey() {
  // 画像表示高速化・段階読込(P1) — 詳細ギャラリーのメイン画像が最初に
  // 使うキーの優先順位: mediumKey > thumbnailKey > storageKey(原本、
  // 最後の手段)。原本を「積極的に選ぶ」ケースが無いことがこのテストの
  // 本体。
  const base: InventoryImageRecord = {
    storageKey: "inventory/original.jpg",
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: null,
    sourceUrl: null,
    thumbnailKey: null,
    mediumKey: null,
    originalHash: null,
    classification: null,
  };
  assertEqual(effectiveHeroKey(base), "inventory/original.jpg", "effectiveHeroKey: falls back to the original when neither medium nor thumbnail exists");
  assertEqual(
    effectiveHeroKey({ ...base, thumbnailKey: "inventory/thumbnails/small.jpg" }),
    "inventory/thumbnails/small.jpg",
    "effectiveHeroKey: falls back to the thumbnail when no medium exists",
  );
  assertEqual(
    effectiveHeroKey({ ...base, thumbnailKey: "inventory/thumbnails/small.jpg", mediumKey: "inventory/medium/mid.jpg" }),
    "inventory/medium/mid.jpg",
    "effectiveHeroKey: prefers the medium derivative when one exists, even if a thumbnail also exists",
  );
}

function testEffectiveListThumbnailKey() {
  const base: InventoryImageRecord = {
    storageKey: "inventory/original.jpg",
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: null,
    sourceUrl: null,
    thumbnailKey: null,
    mediumKey: null,
    originalHash: null,
    classification: null,
  };
  assertEqual(effectiveListThumbnailKey(base), "inventory/original.jpg", "effectiveListThumbnailKey: falls back to the original when no thumbnail exists (pre-backfill/failed generation)");
  assertEqual(
    effectiveListThumbnailKey({ ...base, thumbnailKey: "inventory/thumbnails/small.jpg" }),
    "inventory/thumbnails/small.jpg",
    "effectiveListThumbnailKey: uses the thumbnail when one exists",
  );
}

function testUpdatedAtSort() {
  // 2026-08-29統合改修版 §9の回帰テスト: 一覧デフォルトはupdatedAt DESC。
  const rows = [
    { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", updatedAt: "2026-03-01T00:00:00.000Z" },
    { id: "c", updatedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = [...rows].sort(compareByUpdatedAtDesc);
  assertEqual(sorted.map((r) => r.id), ["b", "c", "a"], "compareByUpdatedAtDesc: most recently updated first");

  const tie = [
    { id: "z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "y", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const sortedTie = [...tie].sort(compareByUpdatedAtDesc);
  assertEqual(sortedTie.map((r) => r.id), ["z", "y"], "compareByUpdatedAtDesc: a tie on updatedAt breaks stably by id, not arbitrarily");
}

async function main() {
  await testCreateThenIdempotentUnchanged();
  await testUpdateOnRealChange();
  await testFailureIsolation();
  await testClaimSourceLinkAtomicity();
  await testRaceDuringSingleItemSyncIsCaughtByClaim();
  await testRaceDuringBatchSyncIsCaughtByClaim();
  await testNumberStringIdBoundaryTreatedAsSameSource();
  await testRepeatedFullResyncNeverIncreasesCount();
  await testCreateFailureReleasesClaimForRetry();
  await testReleaseFailureIsReportedWithoutLosingOriginalError();
  testSyncJobIdHasSingleDefinition();
  testHandlerUsesDeltaAwareProcessor();
  testHandlerFetchesExistingSetOncePerInvocation();
  await testPrefetchAndMasterCacheAvoidRepeatedLookups();
  await testDeltaPageProcessorScenarios();
  testBackgroundJobPureHelpers();
  testPurchasePriceAllInCostRule();
  testCalculateItemGrossProfit();
  testSummarizeMonthlyTrend();
  await testThumbnailResize();
  await testMediumResize();
  testEffectiveHeroKey();
  testEffectiveListThumbnailKey();
  testUpdatedAtSort();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-zaico-sync.ts crashed:", err);
  process.exit(1);
});
