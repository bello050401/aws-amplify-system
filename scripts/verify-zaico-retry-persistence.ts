/**
 * task_9c59e22b1e26721377: 「1726d12の新規同期開始時retry消失」の修正の
 * 実境界試験。
 *
 * ── 直した不具合 ────────────────────────────────────────────────
 *
 * `startZaicoBackgroundSyncJob`(lib/inventory/zaicoBackgroundSync.ts)は
 * 既存のZaicoSyncJob singleton行を**更新**して新しい走査を始めるときも、
 * 無条件に`failedSourceIds: serializeFailedRetryState(new Set(), true)`
 * を書いていた——「新規に開始するジョブは旧failedを引き継ぎようがない」
 * という理屈は、行が今まさに初めてcreateされる場合だけ正しい。既存行の
 * updateでこれをやると、前回までに恒久的に失敗し続けていた商品の
 * sourceIdと、その集合が信頼できるか(trusted)の両方が消える——
 * 基準(syncSince)より古い(＝この回のdelta走査からは時刻だけでは
 * 対象に入らない)失敗商品が、次回以降二度と強制再試行されなくなる。
 *
 * ── この試験の設計 ──────────────────────────────────────────────
 *
 * 対象モジュール(lib/inventory/zaicoBackgroundSync.ts)自体は実物の
 * ままimportし、その1つ下の2つの境界だけをmockへ差し替える:
 *   - `@/lib/amplify/dataClient`(serverDataClient/inventoryAuthMode)
 *     → scripts/__mocks__/zaicoBackgroundSync.dataClient.mock.cjs
 *   - `@/lib/zaico/client`(listInventories)
 *     → scripts/__mocks__/zaicoBackgroundSyncApi.mock.cjs
 *
 * scripts/verify-inventory-history-boundary.tsは`node:module`の
 * `registerHooks`(ESM resolve hook)でこれをやっているが、実測すると
 * zaicoBackgroundSync.tsの依存チェーン(→zaicoSyncPorts.ts→
 * lib/amplify/dataClient.ts)はtsxのCJS出力側(`resolveTsPaths`という
 * tsx内部のCJS `Module._resolveFilename`パッチ経由)で解決されており、
 * ESM resolve hookを一切経由しない(実行して確認: 本物の
 * dataClient.tsがそのままロードされ、その内部の`amplify_outputs.json`
 * importで落ちた)。この経路には`require.cache`の事前投入で対応する
 * ——`createRequire`で得たrequireはtsxのグローバルなpath-alias
 * 解決(`@/...`)をそのまま使えるので、`require.resolve(...)`で実際に
 * 解決されるであろう絶対パスを求め、そのキーへ直接mockモジュールを
 * 差し込む。以後、そのパスへのrequire(ESM/CJSどちらの経路であっても
 * 同じNode requireキャッシュを共有する)は全てmockを返す
 * (scripts/verify-inventory-history-boundary.tsのコメントにある
 * 「tsxがCJS出力する…requireするとModule._cacheが分裂し」という
 * 問題も、この方式なら最初から同じrequire.cacheへ直接書くので起きない)。
 *
 * `advanceZaicoBackgroundSyncJob`の`port`引数(ZaicoSyncPort)は元から
 * 差替え可能なので、これとは別に直接in-memory実装を渡す。実
 * `syncOneZaicoItem`/`splitByDelta`/`resolveNextSyncBasis`/
 * `nextFailedRetryIds`/`parseFailedRetryIds`/`serializeFailedRetryState`/
 * `nextFailedSourceIdsTrusted`/`hasUncapturedLegacyFailures`は一切
 * 差し替えない——このin-memory境界の中でそのまま実行される。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-zaico-retry-persistence.ts
 */
import { createRequire } from "node:module";
import {
  parseFailedRetryIds,
  serializeFailedRetryState,
  nextFailedRetryIds,
  nextFailedSourceIdsTrusted,
  hasUncapturedLegacyFailures,
  type ProcessedItemOutcome,
} from "@/lib/inventory/zaicoDelta";
import type { ZaicoInventory } from "@/lib/zaico/client";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/history";
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";

const cjsRequire = createRequire(import.meta.url);
const DATA_CLIENT_MOCK_PATH = "./__mocks__/zaicoBackgroundSync.dataClient.mock.cjs";
const ZAICO_API_MOCK_PATH = "./__mocks__/zaicoBackgroundSyncApi.mock.cjs";
// zaicoBackgroundSync.ts→zaicoSyncPorts.ts→imageServerOps.ts→
// lib/amplify/serverUtils.tsという別経路が`@/amplify_outputs.json`を
// 実importする(dataClient.ts/zaico/client.tsのmockとは無関係な依存
// チェーン)。このファイルは`npx ampx sandbox`で生成される未コミット
// ファイル(.gitignore対象)なので、require.cacheへのmock差し込み
// (=require.resolveが先に成功している前提)が使えない——require.resolve
// 自体がENOENTで失敗する。この関数では対処できないため、実行前に
// リポジトリ直下へscripts/__mocks__/stub-amplify-outputs.cjsと同内容の
// 実ファイルを配置しておく必要がある(このファイルはgitignore済みで
// 実運用のamplify_outputs.jsonを上書きすることはない)。
/**
 * `@/lib/amplify/dataClient`/`@/lib/zaico/client`が実際に解決される
 * であろう絶対パスを求め(tsxのグローバルなpath-alias解決を利用)、
 * そのキーへ直接mockモジュールを差し込む。ファイル冒頭コメント参照。
 */
function installDataClientAndZaicoApiMocks() {
  const dataClientMock = cjsRequire(DATA_CLIENT_MOCK_PATH) as unknown;
  const zaicoApiMock = cjsRequire(ZAICO_API_MOCK_PATH) as unknown;
  const dataClientPath = cjsRequire.resolve("@/lib/amplify/dataClient");
  const zaicoClientPath = cjsRequire.resolve("@/lib/zaico/client");
  cjsRequire.cache[dataClientPath] = {
    id: dataClientPath,
    filename: dataClientPath,
    loaded: true,
    exports: dataClientMock,
  } as unknown as NodeJS.Module;
  cjsRequire.cache[zaicoClientPath] = {
    id: zaicoClientPath,
    filename: zaicoClientPath,
    loaded: true,
    exports: zaicoApiMock,
  } as unknown as NodeJS.Module;
}

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
// ══════════════════════════════════════════════════════════════════
// § 1. 純粋関数の単体試験(zaicoDelta.ts)
// ══════════════════════════════════════════════════════════════════
function testPureFunctions() {
  console.log("── § 1. 純粋関数単体 ────────────────────────────────────────");

  // parseFailedRetryIds: 未設定はuntrusted、空でも安全側。
  {
    const r = parseFailedRetryIds(undefined);
    check(r.ids.size === 0 && r.trusted === false, "parseFailedRetryIds(undefined) → 空 & untrusted");
  }
  {
    const r = parseFailedRetryIds(serializeFailedRetryState(new Set(["a", "b"]), true));
    check(r.ids.size === 2 && r.ids.has("a") && r.ids.has("b") && r.trusted === true, "serialize→parse 往復(trusted:true)");
  }
  {
    // 旧形式(裸配列)はtrustedへ昇格しない。
    const r = parseFailedRetryIds(JSON.stringify(["x"]));
    check(r.ids.size === 1 && r.ids.has("x") && r.trusted === false, "裸配列(旧形式)はtrusted:falseへ倒す");
  }
  {
    // 壊れたJSON。
    const r = parseFailedRetryIds("not json{{{");
    check(r.ids.size === 0 && r.trusted === false, "破損JSON→空 & untrusted");
  }
  {
    // 非文字列混入。
    const r = parseFailedRetryIds(JSON.stringify({ ids: ["a", 123], trusted: true }));
    check(r.ids.size === 1 && r.ids.has("a") && r.trusted === false, "ids内に非文字列混入→trusted:falseへ倒す(黙って通さない)");
  }

  // nextFailedRetryIds: failedは追加、それ以外は除去、未処理は不変。
  {
    const prev = new Set(["keep-untouched", "will-succeed"]);
    const outcomes: ProcessedItemOutcome[] = [
      { zaicoId: "will-succeed", failed: false },
      { zaicoId: "newly-failed", failed: true },
    ];
    const next = nextFailedRetryIds(prev, outcomes);
    check(
      next.has("keep-untouched") && !next.has("will-succeed") && next.has("newly-failed"),
      "nextFailedRetryIds: 成功で除去・新規失敗で追加・未処理は温存",
    );
  }

  // nextFailedSourceIdsTrusted: sticky + since===null&&isDoneのときだけ昇格。
  check(nextFailedSourceIdsTrusted(true, "2026-01-01T00:00:00.000Z", true) === true, "trusted済みはsticky(sinceがあっても維持)");
  check(nextFailedSourceIdsTrusted(false, null, true) === true, "untrusted→since===null&&isDoneでtrusted化");
  check(nextFailedSourceIdsTrusted(false, null, false) === false, "untrusted→since===nullでもisDone falseなら昇格しない(中間checkpoint)");
  check(nextFailedSourceIdsTrusted(false, "2026-01-01T00:00:00.000Z", true) === false, "untrusted→DELTA完了(since!==null)では昇格しない");

  // hasUncapturedLegacyFailures: untrustedかつfailed>0のときだけtrue。
  check(hasUncapturedLegacyFailures(false, 1) === true, "untrusted & failed>0 → 未捕捉の既存失敗あり");
  check(hasUncapturedLegacyFailures(false, 0) === false, "untrusted & failed=0 → 新規ジョブまで巻き添えにしない");
  check(hasUncapturedLegacyFailures(true, 5) === false, "trusted済みなら常にfalse(failedSourceIdsで捕捉保証済み)");
}

// ══════════════════════════════════════════════════════════════════
// § 2. 実境界試験: start/advanceの実関数
// ══════════════════════════════════════════════════════════════════
function makeZaicoItem(overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: 1001,
    title: "retry試験商品",
    quantity: 1,
    unit: "個",
    category: "家具",
    place: "倉庫A",
    etc: null,
    code: null,
    item_image: null,
    optional_attributes: [
      { name: "⚫︎購入価格", value: "1000" },
      { name: "⚫︎販売価格", value: "2000" },
    ],
    ...overrides,
  } as ZaicoInventory;
}

/** verify-zaico-worker-boundary.tsのcreateTestPortと同じ発想。updateInventoryだけ、指定idの間だけ強制的に失敗させられる。 */
function createTestPort() {
  const store = new Map<string, InventoryModel>();
  let nextSkuNum = 1;
  const failingUpdateIds = new Set<string>();

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
      for (const v of store.values()) {
        if ((v as unknown as { sourceInventoryId?: string }).sourceInventoryId === sourceInventoryId && !(v as unknown as { deletedAt?: string }).deletedAt) return v;
      }
      return null;
    },
    async fetchAllZaicoManaged() {
      const map = new Map<string, InventoryModel>();
      for (const v of store.values()) {
        const rec = v as unknown as { sourceSystem?: string; deletedAt?: string; sourceInventoryId?: string };
        if (rec.sourceSystem === "ZAICO" && !rec.deletedAt && rec.sourceInventoryId) map.set(rec.sourceInventoryId, v);
      }
      return map;
    },
    async findOrCreateCategory(name: string) {
      return { id: `cat-${name}`, created: false };
    },
    async findOrCreateLocation(name: string) {
      return { id: `loc-${name}`, created: false };
    },
    async generateSku() {
      return `SKU-${String(nextSkuNum++).padStart(4, "0")}`;
    },
    async createInventory(input: NewInventoryInput) {
      const record = { ...input } as unknown as InventoryModel;
      store.set(input.id, record);
      return record;
    },
    async claimSourceLink() {
      return { claimed: true };
    },
    async releaseSourceLink() {
      /* no-op */
    },
    async updateInventory(input: UpdateInventoryInput) {
      if (failingUpdateIds.has(input.id)) throw new Error(`mock: forced update failure for ${input.id}`);
      const existing = store.get(input.id);
      if (!existing) throw new Error(`mock: no such id ${input.id}`);
      store.set(input.id, { ...existing, ...input } as unknown as InventoryModel);
    },
    async logHistory(_inventoryId: string, _who: string | null, _changes: HistoryFieldChange[]) {
      /* no-op */
    },
    async downloadAndImportImage(url: string) {
      return { storageKey: `mock-storage-key-for/${url}`, thumbnailKey: `mock-thumbnail-key-for/${url}`, originalHash: `mock-hash-for/${url}` };
    },
    async removeImage() {
      /* no-op */
    },
  };

  return {
    port,
    store,
    setUpdateFailure: (id: string, shouldFail: boolean) => {
      if (shouldFail) failingUpdateIds.add(id);
      else failingUpdateIds.delete(id);
    },
  };
}

async function testRealBoundary() {
  console.log("── § 2. 実境界試験(start/advance実関数) ─────────────────────");

  installDataClientAndZaicoApiMocks();
  const dataMock = cjsRequire(DATA_CLIENT_MOCK_PATH) as {
    __setJobRow: (row: Record<string, unknown> | null) => void;
    __getJobRow: () => Record<string, unknown> | null;
    __rejectNextUpdate: (message?: string) => void;
  };
  const apiMock = cjsRequire(ZAICO_API_MOCK_PATH) as {
    __setPages: (pages: { items: ZaicoInventory[]; hasMore: boolean }[]) => void;
  };
  // installDataClientAndZaicoApiMocks()より後でなければならない——
  // require.cacheへmockを差し込んだ後に初めてzaicoBackgroundSync.tsを
  // requireする(その依存チェーンがdataClient.ts/zaico/client.tsへ
  // 到達した時点で、既にmockがキャッシュに乗っている必要がある)。
  const zbs = cjsRequire("@/lib/inventory/zaicoBackgroundSync") as typeof import("../lib/inventory/zaicoBackgroundSync");

  // ── Test A: 初回1件失敗→完了→実start→次workerで古い失敗を再処理→成功後だけretry削除 ──
  {
    dataMock.__setJobRow(null);

    // 事前状態: FAIL-1は既にBELLOに存在する(前々回作成済み・sourceSystem=ZAICO)。
    // これにより「existsInBelloで強制再試行される」経路とfailedSourceIds
    // 経由の強制再試行を区別できる——このテストはfailedSourceIdsの経路
    // だけを見る。
    const { port: port1, store: store1, setUpdateFailure } = createTestPort();
    store1.set("inv-fail-1", {
      id: "inv-fail-1",
      sourceSystem: "ZAICO",
      sourceInventoryId: "9001",
      deletedAt: null,
      name: "旧名",
    } as unknown as InventoryModel);

    apiMock.__setPages([
      {
        items: [
          makeZaicoItem({ id: 9001, title: "更新に失敗し続ける商品", updated_at: "2020-01-01T00:00:00+09:00" }),
          makeZaicoItem({ id: 9002, title: "正常に作成される商品", updated_at: "2020-01-01T00:00:00+09:00" }),
        ],
        hasMore: false,
      },
    ]);
    setUpdateFailure("inv-fail-1", true);

    // 1回目のstart: 行が無いので新規create。mode省略時DELTA、lastSuccess
    // が無いのでsyncSince=null(初回=全件相当)。
    const start1 = await zbs.startZaicoBackgroundSyncJob("tester@example.com");
    check(start1.started === true, "run1: startZaicoBackgroundSyncJob(新規行)が成功する");

    const advance1 = await zbs.advanceZaicoBackgroundSyncJob("tester@example.com", port1);
    check(advance1.job.status === "COMPLETED", "run1: 1ページのみ→即COMPLETED");
    check(advance1.job.failed === 1 && advance1.job.created === 1, "run1: 1件失敗・1件新規作成");
    check(advance1.job.pendingRetryCount === 1, "run1完了時点でpendingRetryCount=1(失敗商品を捕捉)");

    const rawAfterRun1 = dataMock.__getJobRow();
    const parsedAfterRun1 = parseFailedRetryIds(rawAfterRun1?.failedSourceIds);
    check(parsedAfterRun1.ids.has("9001") && parsedAfterRun1.trusted === true, "run1完了直後: raw行のfailedSourceIdsに9001が入り、trusted=true(since===null&&isDoneの本物の全件完走)");

    // ── ここが本題: 2回目のstartを挟む ──
    const start2 = await zbs.startZaicoBackgroundSyncJob("tester@example.com", "DELTA");
    check(start2.started === true, "run2: startZaicoBackgroundSyncJob(既存行の更新)が成功する");

    const rawAfterStart2 = dataMock.__getJobRow();
    const parsedAfterStart2 = parseFailedRetryIds(rawAfterStart2?.failedSourceIds);
    check(
      parsedAfterStart2.ids.has("9001") && parsedAfterStart2.trusted === true,
      "★要件: startを挟んでも9001がfailedSourceIdsに残る(退行の直接再現ポイント)",
    );
    check(rawAfterStart2?.failed === 0, "run2開始直後: このrunのfailedカウンタ自体は0にリセットされる(retry集合とは別物)");

    // run2: 9001のZAICO側updated_atは2020年のまま(古い)。syncSinceは
    // run1のstartedAtから5分巻き戻した"最近"の時刻——時刻だけならskip
    // されるはずだが、failedSourceIdsが健在ならforce再試行される。
    // 今回は9001の更新を成功させる(retryが解決するケース)。
    // 9001はrun1で既にBELLOに存在する(9002はrun1で新規作成済み)ので、
    // ここでも事前登録しておく——updateInventoryが実際に呼ばれること
    // (＝existsInBello判定では救われない、failedSourceIds経由の強制再
    // 試行であること)を確認するため。
    const port2WithExisting = createTestPort();
    port2WithExisting.store.set("inv-fail-1", {
      id: "inv-fail-1",
      sourceSystem: "ZAICO",
      sourceInventoryId: "9001",
      deletedAt: null,
      name: "旧名",
    } as unknown as InventoryModel);
    apiMock.__setPages([
      {
        items: [makeZaicoItem({ id: 9001, title: "今度は成功する", updated_at: "2020-01-01T00:00:00+09:00" })],
        hasMore: false,
      },
    ]);

    const advance2 = await zbs.advanceZaicoBackgroundSyncJob("tester@example.com", port2WithExisting.port);
    check(advance2.job.status === "COMPLETED", "run2: COMPLETEDまで到達");
    check(advance2.job.updated === 1 && advance2.job.failed === 0, "★要件: run2で9001が実際に再処理され、今回は成功(updated)する(古いupdated_atにも関わらずskipされなかった)");
    check(advance2.job.pendingRetryCount === 0, "★要件: 成功して初めてretryが解除される(pendingRetryCount=0)");

    const rawAfterRun2 = dataMock.__getJobRow();
    const parsedAfterRun2 = parseFailedRetryIds(rawAfterRun2?.failedSourceIds);
    check(!parsedAfterRun2.ids.has("9001"), "run2完了後のraw行からも9001が除去されている");
  }

  // ── Test B: untrusted(移行前)既存行→start→trustedへ勝手に昇格しない ──
  {
    dataMock.__setJobRow({
      id: ZAICO_SYNC_JOB_ID,
      status: "COMPLETED",
      lastPage: 3,
      totalProcessed: 10,
      created: 2,
      updated: 3,
      unchanged: 3,
      failed: 2, // この機能が入る前に積まれた失敗——failedSourceIdsには一度も書かれていない
      imageImported: 0,
      seenSourceIds: JSON.stringify([]),
      // failedSourceIds未設定 = この機能導入前からの行(移行前)。
      lastSuccessfulSyncAt: "2026-09-01T00:00:00.000Z",
      startedAt: "2026-08-31T23:50:00.000Z",
      finishedAt: "2026-09-01T00:00:00.000Z",
    });

    const rawBefore = dataMock.__getJobRow();
    const parsedBefore = parseFailedRetryIds(rawBefore?.failedSourceIds);
    check(parsedBefore.trusted === false, "前提: 移行前の行はfailedSourceIds未設定→untrusted");

    const started = await zbs.startZaicoBackgroundSyncJob("tester@example.com", "DELTA");
    check(started.started === true, "untrusted既存行→startが成功する");

    const rawAfter = dataMock.__getJobRow();
    check(rawAfter?.syncSince === null, "未捕捉の旧失敗は全件再捕捉してから差分へ戻す");
    const parsedAfter = parseFailedRetryIds(rawAfter?.failedSourceIds);
    check(
      parsedAfter.ids.size === 0 && parsedAfter.trusted === false,
      "★要件: untrusted既存行のstartは trusted:true へ勝手に昇格させない(旧バグは常にtrusted:trueで上書きしていた)",
    );
  }

  // ── Test C: 行が全く無い(真の初回) → trusted:true+空で初期化してよい ──
  {
    dataMock.__setJobRow(null);
    const started = await zbs.startZaicoBackgroundSyncJob("tester@example.com", "FULL");
    check(started.started === true, "真の初回(行が無い)→startが成功する");
    const raw = dataMock.__getJobRow();
    const parsed = parseFailedRetryIds(raw?.failedSourceIds);
    check(parsed.ids.size === 0 && parsed.trusted === true, "真の初回createは空+trusted:trueで初期化してよい(持ち越すものが無いため)");
  }

  // ── Test D: 開始の書き込み自体が失敗する → 既存のfailedSourceIdsは無傷のまま ──
  {
    dataMock.__setJobRow({
      id: ZAICO_SYNC_JOB_ID,
      status: "COMPLETED",
      failed: 0,
      seenSourceIds: JSON.stringify([]),
      failedSourceIds: serializeFailedRetryState(new Set(["keep-me"]), true),
      lastSuccessfulSyncAt: "2026-09-01T00:00:00.000Z",
    });
    dataMock.__rejectNextUpdate("DynamoDB一時障害(テスト用)");

    const started = await zbs.startZaicoBackgroundSyncJob("tester@example.com", "DELTA");
    check(started.started === false, "開始の書き込み失敗→started:falseを返す");
    check(typeof started.reason === "string" && started.reason.length > 0, "開始失敗時にreasonを返す");

    const raw = dataMock.__getJobRow();
    const parsed = parseFailedRetryIds(raw?.failedSourceIds);
    check(parsed.ids.has("keep-me") && parsed.trusted === true, "書き込み失敗時、既存行のfailedSourceIdsは変更されず残る(部分書き込みなし)");
  }

  // ── Test E: 停止(cancel)してから再開(start) → failedSourceIdsは持ち越される ──
  {
    dataMock.__setJobRow({
      id: ZAICO_SYNC_JOB_ID,
      status: "RUNNING",
      failed: 1,
      seenSourceIds: JSON.stringify([]),
      failedSourceIds: serializeFailedRetryState(new Set(["still-pending"]), true),
      lastSuccessfulSyncAt: null,
      startedAt: "2026-09-14T00:00:00.000Z",
    });

    await zbs.cancelZaicoBackgroundSyncJob();
    const rawAfterCancel = dataMock.__getJobRow();
    check(rawAfterCancel?.status === "CANCELLED", "cancelでstatus=CANCELLEDになる");
    const parsedAfterCancel = parseFailedRetryIds(rawAfterCancel?.failedSourceIds);
    check(parsedAfterCancel.ids.has("still-pending"), "cancel自体はfailedSourceIdsに触れない");

    const restarted = await zbs.startZaicoBackgroundSyncJob("tester@example.com", "DELTA");
    check(restarted.started === true, "CANCELLED行への再startが成功する");
    const rawAfterRestart = dataMock.__getJobRow();
    const parsedAfterRestart = parseFailedRetryIds(rawAfterRestart?.failedSourceIds);
    check(parsedAfterRestart.ids.has("still-pending"), "★要件: 停止→再開(cancel→start)を挟んでもfailedSourceIdsが消えない");
  }
}

async function main() {
  testPureFunctions();
  await testRealBoundary();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-zaico-retry-persistence: 予期しない例外:", err);
  process.exit(1);
});
