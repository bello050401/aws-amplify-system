/**
 * task_1606b70ae261d392e1: 「実worker境界試験」——実`runSyncWorker`共通処理
 * (amplify/functions/zaico-sync-worker/handler.ts)そのものを、一切
 * 差し替えずに呼び出し、外部境界(DynamoDB/ZAICO API/port)だけを
 * mockする合成境界試験。
 *
 * ── 既存試験との違い ─────────────────────────────────────────────
 *
 * `scripts/verify-zaico-sync.ts`の`testDeltaPageProcessorScenarios`は
 * `syncPendingItemsWithDelta`(handler.tsの内部で使われる1関数)を
 * 直接呼ぶ単体試験であり、handler.ts自体の
 *   - lease確保/heartbeat/解放(claimOrRenewLease/releaseLease)
 *   - retryCount記録・MAX_RETRIES_BEFORE_FAILED到達時のFAILED遷移
 *   - try/catch/finallyの配線そのもの
 *   - ページloop・checkpoint書き込み(writeCheckpoint)・再開(seenSourceIds)
 * は一度も実行しない(testHandlerUsesDeltaAwareProcessor/
 * testHandlerFetchesExistingSetOncePerInvocationはソースの静的検査に
 * 留まり、実行はしていない)。
 *
 * このファイルは実`runSyncWorker`共通処理を実際に呼び出し、上記すべてを実行させる。
 *
 * ── mockの当て方(実handler本体のロジックには一切手を入れない) ──────
 *
 * 1. DynamoDB: `@aws-sdk/lib-dynamodb`の`DynamoDBDocumentClient.prototype.
 *    send`をこのプロセス内でprototype置換する。handler.tsのモジュール
 *    スコープ`ddb`は`DynamoDBDocumentClient.from(...)`が返す実クラスの
 *    インスタンスであり、`.send`はプロトタイプ経由で解決されるため、
 *    インスタンス生成のタイミングに関係なく差し替えが効く。
 *    ZaicoSyncJobの単一行をin-memoryで模したストアに対して
 *    GetCommand/UpdateCommand(SET/REMOVE式・ConditionExpression)を
 *    解釈する簡易実装。
 * 2. ZAICO API・port: `handler.ts`が公開する`HandlerTestOverrides`
 *    (`listInventories`/`createLambdaSyncPort`/`findMissingZaicoManagedInventory`)
 *    へ`handler(overrides)`として明示的に渡す。
 *
 *    当初はこの3つも`Object.defineProperty`でモジュール名前空間の
 *    exportを直接書き換える案だった(DynamoDBと同じ発想)が、実行して
 *    確認したところ`TypeError: Cannot redefine property: listInventories`
 *    で落ちた——tsxの実行環境ではESMの名前付きexportは実際に
 *    non-configurableなbindingとして公開されており、「CJSへ変換される
 *    ためconfigurableになる」という当初の想定は誤りだった(実測で
 *    否定された)。`handler.ts`側に元々`HandlerTestOverrides`という
 *    引数差替え口が用意されていたにもかかわらず、実装側のバグで
 *    `listInventoriesFn`/`findMissingZaicoManagedInventoryFn`が計算
 *    されるだけで実際の呼び出しでは使われていなかった(直接
 *    `listInventories`/`findMissingZaicoManagedInventory`を呼んで
 *    いた)ため、この境界試験を書くまで気づかれていなかった——
 *    `handler.ts`側もこの試験の一部として修正済み(該当コミット差分
 *    参照)。以後はこの引数経由の差替えだけに統一し、モジュール
 *    export書き換えは行わない。
 *
 *    実`syncOneZaicoItem`/`syncPendingItemsWithDelta`/
 *    `resolveNextSyncBasis`等のworker関数自体は一切差し替えない
 *    ——portが返すin-memory実装の中でこれらの実関数がそのまま動く。
 *
 * Run with: npm run verify:zaico-worker-boundary
 * (must go through scripts/with-server-only-stub.cjs — handler.tsの
 * 依存先(lib/inventory/zaicoSyncEngine.ts等)がserver-onlyを持つため)
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/history";
import type { ZaicoInventory } from "@/lib/zaico/client";
import { runSyncWorker as handler, type HandlerTestOverrides } from "../amplify/functions/zaico-sync-worker/handler";

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

// ══════════════════════════════════════════════════════════════════
// 境界1: DynamoDB — ZaicoSyncJobの単一行をin-memoryで模す
// ══════════════════════════════════════════════════════════════════
type JobRow = Record<string, unknown>;
let jobStore: JobRow | null = null;
const updateLog: JobRow[] = [];
let ddbCallCount = 0;

function resolveAttrName(token: string, names: Record<string, string>): string {
  return token.startsWith("#") ? names[token] : token;
}

/** handler.tsが実際に発行する2種類のUpdateExpression(SET-only / REMOVE-only)だけを解釈する。汎用DynamoDB式パーサーではない。 */
function applyUpdateExpression(input: Record<string, unknown>, current: JobRow | null): JobRow {
  const item: JobRow = current ? { ...current } : { id: ZAICO_SYNC_JOB_ID };
  const expr = String(input.UpdateExpression ?? "");
  const names = (input.ExpressionAttributeNames as Record<string, string> | undefined) ?? {};
  const values = (input.ExpressionAttributeValues as Record<string, unknown> | undefined) ?? {};

  const setMatch = /SET\s+(.+?)(?:\s+REMOVE\s+.+)?$/is.exec(expr);
  const removeMatch = /REMOVE\s+(.+)$/is.exec(expr);
  if (setMatch) {
    for (const clause of setMatch[1].split(",")) {
      const [rawName, rawValue] = clause.split("=").map((s) => s.trim());
      item[resolveAttrName(rawName, names)] = values[rawValue];
    }
  }
  if (removeMatch) {
    for (const rawName of removeMatch[1].split(",")) {
      delete item[resolveAttrName(rawName.trim(), names)];
    }
  }
  return item;
}

/** claimOrRenewLease/releaseLeaseが使う2つのConditionExpressionだけを解釈する。 */
function evaluateCondition(input: Record<string, unknown>, current: JobRow | null): boolean {
  const expr = input.ConditionExpression as string | undefined;
  if (!expr) return true;
  const values = (input.ExpressionAttributeValues as Record<string, unknown> | undefined) ?? {};
  if (expr.includes("attribute_not_exists(leaseOwner)")) {
    const notExists = !current || current.leaseOwner === undefined;
    const expired = typeof current?.leaseExpiresAt === "string" && typeof values[":nowStr"] === "string" && (current.leaseExpiresAt as string) < (values[":nowStr"] as string);
    const sameOwner = current?.leaseOwner === values[":owner"];
    return notExists || expired || sameOwner;
  }
  if (expr.trim() === "leaseOwner = :owner") {
    return current?.leaseOwner === values[":owner"];
  }
  throw new Error(`verify-zaico-worker-boundary: 未対応のConditionExpression: ${expr}`);
}

function mockDynamoSend(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
  ddbCallCount++;
  const kind = command.constructor.name;
  if (kind === "GetCommand") {
    return Promise.resolve({ Item: jobStore ? { ...jobStore } : undefined });
  }
  if (kind === "UpdateCommand") {
    const ok = evaluateCondition(command.input, jobStore);
    if (!ok) {
      const err = new Error("ConditionalCheckFailedException") as Error & { name: string };
      err.name = "ConditionalCheckFailedException";
      return Promise.reject(err);
    }
    jobStore = applyUpdateExpression(command.input, jobStore);
    updateLog.push({ ...jobStore });
    return Promise.resolve({});
  }
  return Promise.reject(new Error(`verify-zaico-worker-boundary: 未対応のDynamoDBコマンド: ${kind}`));
}

// handler.tsの`ddb`はモジュールスコープの`DynamoDBDocumentClient.from(...)`
// インスタンス。`.send`はプロトタイプ経由で解決されるため、いつ
// インスタンス化されたかに関係なくこのプロトタイプ置換が効く。
(DynamoDBDocumentClient.prototype as unknown as { send: unknown }).send = function (this: unknown, command: never) {
  return mockDynamoSend(command as never);
};

function resetJobStore(row: JobRow | null) {
  jobStore = row ? { ...row } : null;
  updateLog.length = 0;
  ddbCallCount = 0;
}

// ══════════════════════════════════════════════════════════════════
// 境界2: ZAICO API — handler.tsのHandlerTestOverrides.listInventories
// 経由で差し替える(モジュールexportの書き換えではない。ファイル冒頭
// コメント参照)。
// ══════════════════════════════════════════════════════════════════
type PageDef = { items: ZaicoInventory[]; hasMore: boolean } | { error: Error };
let pages: PageDef[] = [];
const listInventoriesCalls: { page: number; perPage?: number }[] = [];

async function mockListInventories(page: number, perPage?: number): Promise<{ items: ZaicoInventory[]; hasMore: boolean }> {
  listInventoriesCalls.push({ page, perPage });
  const def = pages[page - 1];
  if (!def) return { items: [], hasMore: false };
  if ("error" in def) throw def.error;
  return def;
}

function resetZaicoApi(newPages: PageDef[]) {
  pages = newPages;
  listInventoriesCalls.length = 0;
}

// ══════════════════════════════════════════════════════════════════
// 境界3: port — handler.tsのHandlerTestOverrides.createLambdaSyncPort/
// findMissingZaicoManagedInventory経由で差し替える。実syncOneZaicoItem/
// syncPendingItemsWithDelta/resolveNextSyncBasisは一切差し替えない
// ——このin-memory portの中でそのまま実行される。
// ══════════════════════════════════════════════════════════════════
function createTestPort() {
  const store = new Map<string, InventoryModel>();
  const historyLog: { inventoryId: string; who: string | null; changes: HistoryFieldChange[] }[] = [];
  const claimedLinks = new Map<string, string>();
  let nextSkuNum = 1;
  const calls = { fetchAllZaicoManaged: 0, createInventory: 0, updateInventory: 0, generateSku: 0 };

  let generateSkuFailure: Error | null = null;

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
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
      return { id: `cat-${name}`, created: false };
    },
    async findOrCreateLocation(name: string) {
      return { id: `loc-${name}`, created: false };
    },
    async generateSku() {
      calls.generateSku++;
      if (generateSkuFailure) throw generateSkuFailure;
      return `SKU-${String(nextSkuNum++).padStart(4, "0")}`;
    },
    async createInventory(input: NewInventoryInput) {
      calls.createInventory++;
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
      return { storageKey: `mock-storage-key-for/${url}`, thumbnailKey: `mock-thumbnail-key-for/${url}`, originalHash: `mock-hash-for/${url}` };
    },
    async removeImage() {
      /* no-op */
    },
  };

  return {
    port,
    store,
    calls,
    setGenerateSkuFailure: (err: Error | null) => {
      generateSkuFailure = err;
    },
  };
}

function makeZaicoItem(overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: 1001,
    title: "境界試験商品",
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

let fetchAllZaicoManagedOverride: (() => Promise<Map<string, InventoryModel>>) | null = null;
let missingResult: string[] = [];
let missingCallCount = 0;
let activeTestPort: ReturnType<typeof createTestPort> | null = null;

// handler.tsのHandlerTestOverridesへ渡す1つの固定オブジェクト。中身は
// すべて可変な外側変数を参照するクロージャなので、呼び出し時点の最新の
// activeTestPort/fetchAllZaicoManagedOverride/missingResultを見る
// (resetPort等でこれらを差し替えるだけで、このオブジェクト自体を作り
// 直す必要はない)。
const testOverrides: HandlerTestOverrides = {
  listInventories: mockListInventories,
  createLambdaSyncPort: () => {
    const testPort = activeTestPort!;
    if (!fetchAllZaicoManagedOverride) return testPort.port;
    // prefetch例外シナリオ用: fetchAllZaicoManagedだけ差し替えたportを返す。
    return { ...testPort.port, fetchAllZaicoManaged: fetchAllZaicoManagedOverride };
  },
  findMissingZaicoManagedInventory: async (_seen: Set<string>) => {
    missingCallCount++;
    return missingResult;
  },
};

function resetPort(): ReturnType<typeof createTestPort> {
  activeTestPort = createTestPort();
  fetchAllZaicoManagedOverride = null;
  missingResult = [];
  missingCallCount = 0;
  return activeTestPort;
}

// ── 共通のjob行テンプレート ─────────────────────────────────────────
function baseJobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: ZAICO_SYNC_JOB_ID,
    status: "RUNNING",
    lastPage: 0,
    totalProcessed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    imageImported: 0,
    skippedByDelta: 0,
    seenSourceIds: JSON.stringify([]),
    mode: "FULL",
    syncSince: null,
    startedAt: "2026-09-12T00:00:00.000Z",
    lastSuccessfulSyncAt: null,
    retryCount: 0,
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 1. prefetch例外 → retry記録 + lease解放(task_1606b70の主眼)
 * ══════════════════════════════════════════════════════════════════
 * 2f9cc99は`existingBySourceId = await port.fetchAllZaicoManaged()`を
 * try**の外側**に置いていた(task_a320が発見・修正)。これが再発すると、
 * prefetchの例外がcatch(retryCount記録)/finally(releaseLease)の
 * どちらも通らない——このテストはその回帰を実handler呼び出しで検知する。
 */
async function testPrefetchExceptionRecordsRetryAndReleasesLease() {
  resetPort();
  resetZaicoApi([]);
  resetJobStore(baseJobRow());
  fetchAllZaicoManagedOverride = async () => {
    throw new Error("mock: DynamoDB Scan失敗(prefetch)");
  };

  const result = await handler(testOverrides);

  assertEqual(result, { pagesProcessed: 0 }, "prefetch例外: handlerは例外を外へ投げず、0ページ処理として正常return する");
  assertEqual(jobStore?.retryCount, 1, "prefetch例外: catchでretryCountが1へ記録される(=例外がcatchを通った証拠)");
  assertEqual(jobStore?.status, "RUNNING", "prefetch例外: MAX_RETRIES未満なのでstatusはFAILEDにならない");
  assertTrue(typeof jobStore?.lastError === "string" && (jobStore.lastError as string).includes("Scan失敗"), "prefetch例外: lastErrorに実際の例外メッセージが残る");
  assertEqual(jobStore?.leaseOwner, undefined, "prefetch例外: leaseOwnerが残っていない(=finallyのreleaseLeaseを通った証拠)");
  assertEqual(jobStore?.leaseExpiresAt, undefined, "prefetch例外: leaseExpiresAtも解放されている");
  assertEqual(listInventoriesCalls.length, 0, "prefetch例外: prefetch自体が失敗したのでZAICO API(listInventories)は一度も呼ばれない");

  // 2回目の呼び出し(次のスケジュールtick相当): 今度はprefetchが成功する
  // ので、retryが記録されたジョブから正常に再開できることを確認する。
  fetchAllZaicoManagedOverride = null;
  resetZaicoApi([{ items: [makeZaicoItem({ id: 1 })], hasMore: false }]);
  const result2 = await handler(testOverrides);
  assertEqual(result2, { pagesProcessed: 1 }, "prefetch例外からの回復: 次tickでprefetchが成功すれば通常どおり1ページ処理される");
  assertEqual(jobStore?.status, "COMPLETED", "prefetch例外からの回復: retry記録を経てもジョブは正常にCOMPLETEDへ到達する");
  assertEqual(jobStore?.retryCount, 0, "prefetch例外からの回復: 成功したのでretryCountは0へ戻る");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. MAX_RETRIES_BEFORE_FAILED到達 → FAILED化してもlease解放は必ず通る
 * ══════════════════════════════════════════════════════════════════ */
async function testRepeatedFailuresEventuallyMarkFailedAndAlwaysReleaseLease() {
  resetPort();
  resetZaicoApi([]);
  fetchAllZaicoManagedOverride = async () => {
    throw new Error("mock: 継続的な障害");
  };

  for (let i = 1; i <= 5; i++) {
    resetJobStore(baseJobRow({ retryCount: i - 1 }));
    await handler(testOverrides);
    assertEqual(jobStore?.leaseOwner, undefined, `連続失敗${i}回目: leaseは毎回確実に解放される`);
    if (i < 5) {
      assertEqual(jobStore?.status, "RUNNING", `連続失敗${i}回目: MAX_RETRIES(5)未満はまだRUNNINGのまま`);
      assertEqual(jobStore?.retryCount, i, `連続失敗${i}回目: retryCountが${i}へ進む`);
    } else {
      assertEqual(jobStore?.status, "FAILED", "連続失敗5回目: MAX_RETRIES_BEFORE_FAILEDへ到達しFAILEDへ遷移する");
      assertEqual(jobStore?.retryCount, 5, "連続失敗5回目: retryCountは5");
      assertTrue(typeof jobStore?.finishedAt === "string", "連続失敗5回目: finishedAtが記録される(いつ止まったか隠さない)");
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 3. ページ取得失敗(ZAICO API) → retry記録、lastPageは進めない
 * ══════════════════════════════════════════════════════════════════ */
async function testPageFetchFailureDoesNotAdvanceCheckpoint() {
  resetPort();
  resetJobStore(baseJobRow());
  resetZaicoApi([{ error: new Error("mock: ZAICO API 500") }]);

  await handler(testOverrides);

  assertEqual(jobStore?.retryCount, 1, "ページ失敗: retryCountが記録される");
  assertEqual(jobStore?.lastPage, 0, "ページ失敗: lastPageは進めない(同じページを次回取り直す)");
  assertEqual(jobStore?.leaseOwner, undefined, "ページ失敗: leaseは解放される");

  // 次回: 同じページ(1)を取り直し、今度は成功する。
  resetZaicoApi([{ items: [makeZaicoItem({ id: 42 })], hasMore: false }]);
  await handler(testOverrides);
  assertEqual(listInventoriesCalls[0]?.page, 1, "ページ失敗からの再開: 次回も同じページ番号(1)から取り直す");
  assertEqual(jobStore?.status, "COMPLETED", "ページ失敗からの再開: 成功すれば正常にCOMPLETEDする");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 部分失敗(1件のsyncOneZaicoItem失敗) → 基準を進めない
 *    (resolveNextSyncBasisが実handler経由でも効くことの確認)
 * ══════════════════════════════════════════════════════════════════ */
async function testPartialFailureKeepsPreviousBasis() {
  const testPort = resetPort();
  testPort.setGenerateSkuFailure(new Error("mock: SKU発番失敗"));
  const startedAt = "2026-09-12T03:00:00.000Z";
  const previousBasis = "2026-09-01T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt, lastSuccessfulSyncAt: previousBasis }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 501 })], hasMore: false }]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "部分失敗: ページ自体は完走しCOMPLETEDする(例外で全体停止しない)");
  assertEqual(jobStore?.failed, 1, "部分失敗: failedカウントが1");
  assertEqual(jobStore?.lastSuccessfulSyncAt, previousBasis, "部分失敗: 1件でも失敗があった回はlastSuccessfulSyncAtを進めない(resolveNextSyncBasis)");
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 正常完了 → 開始時刻を次回基準として記録する
 * ══════════════════════════════════════════════════════════════════ */
async function testSuccessfulRunUsesStartedAtAsNextBasis() {
  resetPort();
  const startedAt = "2026-09-12T03:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt, lastSuccessfulSyncAt: null }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 900 })], hasMore: false }]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "正常完了: COMPLETEDへ到達する");
  assertEqual(jobStore?.failed, 0, "正常完了: 失敗0件");
  assertEqual(jobStore?.lastSuccessfulSyncAt, startedAt, "正常完了: 次回基準は完了時刻ではなく開始時刻(nextSuccessfulSyncAt)になる");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 既存未変更(BELLOに実在+古い時刻)はskip、BELLO未取込+古い時刻は
 *    取りこぼさず処理する(2026-09-12設計の要——実handler経由で確認)
 * ══════════════════════════════════════════════════════════════════ */
async function testStaleButUntrackedItemIsNotLostThroughRealHandler() {
  const testPort = resetPort();
  const since = "2026-09-01T00:00:00.000Z";
  const staleTimestamp = "2026-08-01T00:00:00.000Z";

  // id=1: 既にBELLOに取り込み済み・時刻は古い → skipされるべき対照群。
  await testPort.port.createInventory({
    id: "inv-1",
    sku: "SKU-EXIST",
    name: "既存商品",
    quantity: 1,
    images: [],
    customFields: undefined,
    createdBy: "seed",
    updatedBy: "seed",
    sourceSystem: "ZAICO",
    sourceInventoryId: "1",
  } as unknown as NewInventoryInput);

  resetJobStore(baseJobRow({ mode: "DELTA", syncSince: since }));
  resetZaicoApi([
    {
      items: [makeZaicoItem({ id: 1, updated_at: staleTimestamp }), makeZaicoItem({ id: 2, title: "取り込み漏れ商品", updated_at: staleTimestamp })],
      hasMore: false,
    },
  ]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "既存未変更/取りこぼし防止: 正常にCOMPLETEDする");
  assertEqual(jobStore?.skippedByDelta, 1, "既存未変更: BELLOに実在するid=1だけがskippedByDeltaに入る");
  assertEqual(jobStore?.totalProcessed, 1, "取りこぼし防止: BELLO未取込のid=2(古い時刻)は実handler経由でも処理される");
  assertEqual(jobStore?.created, 1, "取りこぼし防止: id=2は新規作成される");
  const seen = JSON.parse(String(jobStore?.seenSourceIds ?? "[]")) as string[];
  assertEqual(seen.sort(), ["1", "2"], "取りこぼし防止: 両方とも観測済みになる(削除誤検出を防ぐ)");
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 途中再開(ページ内): 前回のseenSourceIdsを引き継ぎ、同じページの
 *    残りだけを処理する。件数を二重計上しない。
 * ══════════════════════════════════════════════════════════════════ */
async function testMidPageResumeDoesNotDoubleCount() {
  resetPort();
  resetJobStore(
    baseJobRow({
      status: "RUNNING",
      lastPage: 0,
      seenSourceIds: JSON.stringify(["1", "2"]), // 前回のinvocationで既に処理済み
      totalProcessed: 2,
      created: 2,
    }),
  );
  // 同じページ(1)がもう一度取り直される(handler.tsの既存の再開規約)。
  resetZaicoApi([{ items: [makeZaicoItem({ id: 1 }), makeZaicoItem({ id: 2 }), makeZaicoItem({ id: 3 })], hasMore: false }]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "途中再開: 正常にCOMPLETEDする");
  assertEqual(jobStore?.totalProcessed, 3, "途中再開: 既に処理済みのid=1,2は数え直さず、新規のid=3の分だけ増える(2+1=3)");
  assertEqual(jobStore?.created, 3, "途中再開: createdも同様(2+1=3、二重計上していない)");
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 重複ページ(ZAICO側が同じページを2回返す相当) + 1invocation1prefetch
 * ══════════════════════════════════════════════════════════════════ */
async function testDuplicatePagesAndSinglePrefetchPerInvocation() {
  const testPort = resetPort();
  resetJobStore(baseJobRow());
  // 2ページとも同じ3件(重複)を返す——handler.ts自身は重複排除を
  // 「hasMoreがfalseになるまで進む」以上のことはしないため、ページを
  // 跨いだ完全な重複はseenSourceIds(1ページ内はページ先頭のfilterで
  // 弾かれる)では防げない。ここでは「1ページ内での重複」を主眼にする
  // ——同一ページ内に同じidが2回含まれるケース。
  resetZaicoApi([
    { items: [makeZaicoItem({ id: 1 }), makeZaicoItem({ id: 1 }), makeZaicoItem({ id: 2 })], hasMore: false },
  ]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "重複ページ内: 正常にCOMPLETEDする(重複があっても停止しない)");
  // syncOneZaicoItemはsourceInventoryIdでclaim/lookupするため、同一ページ
  // 内の重複id(id=1が2回)はclaimSourceLinkの排他により2回目がunchanged/
  // 更新側に落ちる——「消える」ことも「2重に新規作成される」こともない。
  assertTrue((jobStore?.totalProcessed as number) >= 2, "重複ページ内: 少なくとも一意な2件分(id=1,2)は処理される");
  assertEqual(testPort.calls.fetchAllZaicoManaged, 1, "1invocation1prefetch: このinvocation全体でfetchAllZaicoManagedは1回だけ呼ばれる");
}

/* ══════════════════════════════════════════════════════════════════
 * 9. 複数ページに渡っても1invocation1prefetchが維持される
 * ══════════════════════════════════════════════════════════════════ */
async function testSinglePrefetchAcrossMultiplePages() {
  const testPort = resetPort();
  resetJobStore(baseJobRow());
  resetZaicoApi([
    { items: [makeZaicoItem({ id: 1 })], hasMore: true },
    { items: [makeZaicoItem({ id: 2 })], hasMore: true },
    { items: [makeZaicoItem({ id: 3 })], hasMore: false },
  ]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "複数ページ: 正常にCOMPLETEDする");
  assertEqual(jobStore?.totalProcessed, 3, "複数ページ: 3ページ分すべて処理される");
  assertEqual(listInventoriesCalls.map((c) => c.page), [1, 2, 3], "複数ページ: ページ番号が順に1,2,3で呼ばれる");
  assertEqual(testPort.calls.fetchAllZaicoManaged, 1, "1invocation1prefetch: 3ページ処理してもfetchAllZaicoManagedは1回だけ(ページ毎に増えない)");
  assertEqual(missingCallCount, 1, "missing検出: isDoneに到達した回だけ1回呼ばれる");
}

async function main() {
  await testPrefetchExceptionRecordsRetryAndReleasesLease();
  await testRepeatedFailuresEventuallyMarkFailedAndAlwaysReleaseLease();
  await testPageFetchFailureDoesNotAdvanceCheckpoint();
  await testPartialFailureKeepsPreviousBasis();
  await testSuccessfulRunUsesStartedAtAsNextBasis();
  await testStaleButUntrackedItemIsNotLostThroughRealHandler();
  await testMidPageResumeDoesNotDoubleCount();
  await testDuplicatePagesAndSinglePrefetchPerInvocation();
  await testSinglePrefetchAcrossMultiplePages();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-zaico-worker-boundary.ts crashed:", err);
  process.exit(1);
});

