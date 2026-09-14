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
import {
  parseFailedRetryIds,
  nextFailedSourceIdsTrusted,
  hasUncapturedLegacyFailures,
  serializeFailedRetryState,
} from "@/lib/inventory/zaicoDelta";

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
/** task_ff42042dfee35233e9: 次のCOMPLETED書き込みだけ人為的に失敗させる(checkpoint拒否試験用)。1回使うと自動でfalseに戻る。 */
let rejectNextCompletionWrite = false;

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
    const next = applyUpdateExpression(command.input, jobStore);
    if (rejectNextCompletionWrite && next.status === "COMPLETED") {
      rejectNextCompletionWrite = false;
      // 実DynamoDBのUpdateCommandは失敗時に対象行を一切変更しない
      // (単一itemへの原子的な書き込み)——jobStoreをそのまま保つことで
      // その保証をこのmockでも再現する。
      return Promise.reject(new Error("mock: checkpoint保存失敗(ProvisionedThroughputExceeded等)"));
    }
    jobStore = next;
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
  rejectNextCompletionWrite = false;
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
  /** task_ff42042dfee35233e9: 恒久失敗試験用。1件のupdateInventoryだけを継続的に失敗させる。 */
  let updateInventoryFailure: Error | null = null;

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
      if (updateInventoryFailure) throw updateInventoryFailure;
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
    setUpdateInventoryFailure: (err: Error | null) => {
      updateInventoryFailure = err;
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
 * 4. 部分失敗(1件のsyncOneZaicoItem失敗) → 基準は前進し、失敗した
 *    商品だけが恒久失敗リストへ入って次回強制再試行される
 *    (task_23b5395c49434d58b8: 「1件でも失敗があれば基準を止める」は、
 *    恒久失敗1件が全件を道連れにして「毎回初回のため全件」になる
 *    不具合の原因だったため置き換えた)
 * ══════════════════════════════════════════════════════════════════ */
async function testPartialFailureAdvancesBasisAndQueuesRetry() {
  const testPort = resetPort();

  // ── Run A: FULL、501は正常に新規作成される(対照として、恒久失敗の
  //    対象がBELLOに実在する状態を作る)。
  const startedA = "2026-09-11T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt: startedA, lastSuccessfulSyncAt: null }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 501, updated_at: "2026-09-10T00:00:00.000Z" })], hasMore: false }]);
  await handler(testOverrides);
  assertEqual(jobStore?.status, "COMPLETED", "Run A: 正常にCOMPLETEDし、501が新規作成される");
  assertEqual(jobStore?.created, 1, "Run A: 501は新規作成");
  assertEqual(jobStore?.lastSuccessfulSyncAt, startedA, "Run A: 基準はこの回の開始時刻");

  // ── Run B: DELTA。501の更新が恒久的に失敗し続ける。他の正常な商品を
  //    巻き添えにしないよう、基準はこの回でも前進すべき。
  testPort.setUpdateInventoryFailure(new Error("mock: 恒久的なupdateInventory失敗(データ不整合)"));
  const startedB = "2026-09-12T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "DELTA", syncSince: startedA, startedAt: startedB, lastSuccessfulSyncAt: startedA }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 501, quantity: 2, updated_at: "2026-09-11T12:00:00.000Z" })], hasMore: false }]);
  await handler(testOverrides);
  assertEqual(jobStore?.status, "COMPLETED", "Run B: ページ自体は完走しCOMPLETEDする(例外で全体停止しない)");
  assertEqual(jobStore?.failed, 1, "Run B: failedカウントが1");
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    startedB,
    "Run B: 部分失敗でも基準は前進する(失敗商品はfailedSourceIdsで別途強制再試行されるため)",
  );
  const failedIds = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(Array.from(failedIds.ids), ["501"], "Run B: 失敗した商品のsourceIdが恒久失敗リストへ記録される");

  // ── Run C: DELTA。syncSinceは501のupdated_atより後(時刻だけならskip
  //    対象)。恒久失敗リストだけがこの商品を救えることを確認する。
  testPort.setUpdateInventoryFailure(null);
  const startedC = "2026-09-13T00:00:00.000Z";
  resetZaicoApi([{ items: [makeZaicoItem({ id: 501, quantity: 2, updated_at: "2026-09-11T12:00:00.000Z" })], hasMore: false }]);
  resetJobStore(
    baseJobRow({
      mode: "DELTA",
      syncSince: startedB,
      startedAt: startedC,
      lastSuccessfulSyncAt: startedB,
      // 旧形式(裸の配列)から読んでも壊れず動くことも合わせて確認する。
      failedSourceIds: JSON.stringify(["501"]),
      seenSourceIds: JSON.stringify([]),
    }),
  );
  await handler(testOverrides);
  assertEqual(jobStore?.status, "COMPLETED", "Run C: 恒久失敗の再試行後もCOMPLETEDする");
  assertEqual(jobStore?.skippedByDelta, 0, "Run C: 恒久失敗リストに載っているため強制的にtoProcessへ回りskipされない");
  assertEqual(jobStore?.totalProcessed, 1, "Run C: 501が実際に(強制的に)再試行される");
  assertEqual(jobStore?.failed, 0, "Run C: 今回は成功する");
  const failedIdsAfterRetry = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(Array.from(failedIdsAfterRetry.ids), [], "Run C: 成功したので恒久失敗リストから外れる");
  assertEqual(jobStore?.lastSuccessfulSyncAt, startedC, "Run C: 基準はこの回の開始時刻へさらに前進する");
}

/* ══════════════════════════════════════════════════════════════════
 * 4b. 移行安全性(task_8ff5754e48711a753a): failedSourceIdsが導入される
 *    前から実行中(RUNNING)だったジョブは、旧failed分を新形式retry集合
 *    へ捕捉できていない——基準を前進させると取りこぼす。
 * ══════════════════════════════════════════════════════════════════ */
async function testLegacyRunningJobWithUncapturedFailuresBlocksBasisAdvance() {
  resetPort();
  const previousBasis = "2026-09-01T00:00:00.000Z";
  const startedAt = "2026-09-12T00:00:00.000Z";
  // 旧コードのもとで既に1件failedし、そのsourceId(500)はseenSourceIdsへ
  // 登録済み(=このinvocationでは再処理されない)——failedSourceIds自体は
  // まだ一度も書かれていない(undefined、この機能が導入される前の行)。
  resetJobStore(
    baseJobRow({
      mode: "DELTA",
      syncSince: previousBasis,
      startedAt,
      lastSuccessfulSyncAt: previousBasis,
      failed: 1,
      totalProcessed: 1,
      seenSourceIds: JSON.stringify(["500"]),
      // failedSourceIds: 未設定(旧行のまま)
    }),
  );
  resetZaicoApi([{ items: [makeZaicoItem({ id: 600, updated_at: "2026-09-11T00:00:00.000Z" })], hasMore: false }]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "移行: 残りページを完走しCOMPLETEDする");
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    previousBasis,
    "移行: failedSourceIds未設定+既存failedがある回は基準を前進させない(旧失敗の取りこぼし防止)",
  );
  // task_ff42042dfee35233e9: このフィールドへは今回も書き込まれるが、
  // DELTA完了は「本物の全件完走」(since===null)ではないので、trustedには
  // ならない(旧不具合: 「配列が書ければtrusted」だとここでtrue化して
  // しまい、下のnext-invokeテストが偽陽性でpassしてしまっていた)。
  const afterInvoke1 = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(afterInvoke1.trusted, false, "移行: DELTA完了の書き込みだけではtrusted化されない(checkpoint跨ぎの誤trusted化を防ぐ核心)");
  assertEqual(Array.from(afterInvoke1.ids), [], "移行: 今回は新たな失敗が無いのでids自体は空");

  // ── 次回: 基準が前進していないので、500は同じsyncSinceで再スキャン
  //    対象に戻る(安全な再捕捉)。ジョブ行はresetせず、invoke1が実際に
  //    書き込んだ状態をそのまま引き継ぐ(=別invocationの再現)。
  const nextStarted = "2026-09-14T00:00:00.000Z";
  resetZaicoApi([{ items: [makeZaicoItem({ id: 500, updated_at: "2026-08-15T00:00:00.000Z" })], hasMore: false }]);
  // 前回のCOMPLETEDのままだとhandlerがPENDING/RUNNINGでないjobとしてskipして
  // しまう——「別のLambda invocationが同じ(未前進の)基準でこの行を
  // 再度PENDING化して拾った」状態を模す。
  jobStore = { ...jobStore, status: "RUNNING", startedAt: nextStarted, lastPage: 0, seenSourceIds: JSON.stringify([]) };
  const totalProcessedBeforeThisInvoke = Number(jobStore.totalProcessed ?? 0);
  await handler(testOverrides);
  assertEqual(jobStore?.status, "COMPLETED", "次回安全再捕捉: 正常にCOMPLETEDする");
  assertEqual(
    jobStore?.totalProcessed,
    totalProcessedBeforeThisInvoke + 1,
    "次回安全再捕捉: 基準が前進していないおかげでid=500が再スキャン対象に戻り、実際に処理される(未捕捉IDが古いupdated_atでも処理される)",
  );
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    previousBasis,
    "次回安全再捕捉: このジョブ行はfailed=1を積んだまま(初期の移行未捕捉分)なので、trustedがtrueになるまで基準はまだ前進しない(=このDELTAジョブは自力では解決しない。4cのFULL再走査で解消する)",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 4c. checkpoint跨ぎの移行安全性(task_ff42042dfee35233e9、独自レビュー
 *    で指摘された穴の再現試験): 1 invocationで完了しない旧RUNNING job
 *    ——中間(RUNNING)checkpointが先にfailedSourceIdsを書き込んでも、
 *    別のinvocationがそれを「trusted」と誤認して基準を前進させない
 *    こと。最後にFULLモードの全件再走査が起きたときだけ解消すること。
 * ══════════════════════════════════════════════════════════════════ */
async function testLegacyRunningJobUncapturedFailureSurvivesAcrossCheckpoints() {
  resetPort();
  const previousBasis = "2026-09-01T00:00:00.000Z";
  const startedAt = "2026-09-12T00:00:00.000Z";
  // 旧コードのもとで既に1件failedし(failed=1)、そのsourceIdは分からない
  // (failedSourceIds自体がまだ一度も書かれていない=undefined)。このジョブ
  // は2ページ分あり、1ページ目は成功するが、2ページ目の取得がこの
  // invocationでは失敗して終わる——1ページ目の**中間(RUNNING)
  // checkpoint**が書かれた後にinvocationが終わる状況を作る。
  resetJobStore(
    baseJobRow({
      mode: "DELTA",
      syncSince: previousBasis,
      startedAt,
      lastSuccessfulSyncAt: previousBasis,
      failed: 1,
      totalProcessed: 1,
      seenSourceIds: JSON.stringify(["500"]),
      // failedSourceIds: 未設定(旧行のまま)
    }),
  );
  resetZaicoApi([
    { items: [makeZaicoItem({ id: 600, updated_at: "2026-09-11T00:00:00.000Z" })], hasMore: true },
    { error: new Error("mock: 2ページ目取得失敗(このinvocationはここで終わる)") },
  ]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "RUNNING", "中間checkpoint: このinvocationはCOMPLETEDに至らずRUNNINGのまま終わる");
  assertEqual(jobStore?.lastPage, 1, "中間checkpoint: 1ページ目までは進む");
  const midRun = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(midRun.trusted, false, "中間checkpoint: 中間(RUNNING)書き込みだけでtrustedにならない(=今回の不具合そのものの再現ポイント)");
  assertEqual(jobStore?.lastSuccessfulSyncAt, previousBasis, "中間checkpoint: 基準はまだ動いていない(そもそも完了していない)");

  // ── 別invocation: 2ページ目の取得が今度は成功し、ジョブが完了する。
  //    jobStoreはresetせず、invocation 1が実際に残した状態(=DynamoDB上の
  //    永続状態)をそのまま次のLambda呼び出しが読む、という実際の境界を
  //    再現する。lastPageが既に1なので、このinvocationはpage=2から取り直す
  //    (index[0]は再取得されない)。
  resetZaicoApi([
    { items: [], hasMore: false },
    { items: [makeZaicoItem({ id: 601, updated_at: "2026-09-11T00:00:00.000Z" })], hasMore: false },
  ]);
  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "別invokeで完了: 2ページ目も成功しCOMPLETEDする");
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    previousBasis,
    "別invokeで完了(核心アサーション): 中間checkpointが先にtrusted化していないため、この回もまだ旧failed(id=500)の捕捉保証が無いとみなされ、基準は前進しない",
  );
  const afterCompletion = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(afterCompletion.trusted, false, "別invokeで完了: DELTA完了はtrusted化の条件(since===null)を満たさないので、なおuntrustedのまま");

  // ── 次の正常走査(FULLモードの新規ジョブ)後に解消する。未捕捉のid=500は
  //    ZAICO側updated_atが frozen since より古いままでも、FULLは時刻を
  //    無視するので確実に再処理される。
  const nextStarted = "2026-09-14T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt: nextStarted, lastSuccessfulSyncAt: previousBasis }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 500, updated_at: "2026-08-15T00:00:00.000Z" })], hasMore: false }]);
  await handler(testOverrides);
  assertEqual(jobStore?.status, "COMPLETED", "次回FULL再走査: 正常にCOMPLETEDする");
  assertEqual(jobStore?.totalProcessed, 1, "次回FULL再走査: id=500がFULLモードで(古いupdated_atでも時刻を無視して)再処理される");
  assertEqual(jobStore?.lastSuccessfulSyncAt, nextStarted, "次回FULL再走査: 本物の全件完走なので基準が前進する(解消)");
  const afterFullScan = parseFailedRetryIds(jobStore?.failedSourceIds);
  assertEqual(afterFullScan.trusted, true, "次回FULL再走査: since===nullを伴う完了でtrusted化される(以後は個別のfailedSourceIdsだけで正しく運用できる)");
}

/* ══════════════════════════════════════════════════════════════════
 * 4d. 破損したfailedSourceIds(非文字列混入・JSON.parse失敗)も「空だが
 *    信頼できる」とは混同しない——黙ってfilterしてtrustedを通さない。
 *    raw値そのものはエラーログに出さない。
 * ══════════════════════════════════════════════════════════════════ */
async function testCorruptedFailedSourceIdsBlocksBasisAdvance() {
  resetPort();
  const previousBasis = "2026-09-01T00:00:00.000Z";
  const secretLookingId = "SECRET-LOOKING-RAW-VALUE-12345";
  resetJobStore(
    baseJobRow({
      mode: "DELTA",
      syncSince: previousBasis,
      startedAt: "2026-09-12T00:00:00.000Z",
      lastSuccessfulSyncAt: previousBasis,
      failed: 2,
      // 非文字列(数値)が混じった破損配列。
      failedSourceIds: JSON.stringify({ ids: ["700", 701, secretLookingId], trusted: true }),
    }),
  );
  resetZaicoApi([{ items: [makeZaicoItem({ id: 700 })], hasMore: false }]);

  const originalConsoleError = console.error;
  const loggedArgs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedArgs.push(args);
  };
  try {
    await handler(testOverrides);
  } finally {
    console.error = originalConsoleError;
  }

  assertEqual(jobStore?.status, "COMPLETED", "破損JSON: 正常にCOMPLETEDする(例外で全体停止しない)");
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    previousBasis,
    "破損JSON: 非文字列混入は「空だが信頼できない」扱いになり、trusted:trueを名乗っていても黙って信用しない",
  );
  const loggedText = loggedArgs.map((a) => a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ")).join("\n");
  assertTrue(!loggedText.includes(secretLookingId), "破損JSON: raw retry集合の中身そのものはエラーログに出さない(件数だけ)");
}

/* ══════════════════════════════════════════════════════════════════
 * 4e. 通常初回: failedSourceIds未設定でも、既存failedが0件(=本当に
 *    新規のジョブ)なら基準前進を止めない——新規ジョブまで巻き添えに
 *    しないことの確認。
 * ══════════════════════════════════════════════════════════════════ */
async function testFreshJobWithNoFailuresAdvancesBasisNormally() {
  resetPort();
  const startedAt = "2026-09-12T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt, lastSuccessfulSyncAt: null, failed: 0 }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 800 })], hasMore: false }]);

  await handler(testOverrides);

  assertEqual(jobStore?.status, "COMPLETED", "通常初回: 正常にCOMPLETEDする");
  assertEqual(jobStore?.lastSuccessfulSyncAt, startedAt, "通常初回: failedSourceIds未設定でも既存failedが0件なら基準は通常どおり前進する");
}

/* ══════════════════════════════════════════════════════════════════
 * 4f. checkpoint保存拒否: 完了時のUpdateCommandが失敗したら、基準
 *    (lastSuccessfulSyncAt)も他のcompletedフィールドも一切書き込まれ
 *    ない(1回のUpdateCommandの原子性に依存)——保存失敗が「基準だけ
 *    先に進んでcheckpointが後から失敗する」半端な状態を作らないこと。
 * ══════════════════════════════════════════════════════════════════ */
async function testCompletionCheckpointFailureDoesNotAdvanceBasis() {
  resetPort();
  const previousBasis = "2026-09-01T00:00:00.000Z";
  resetJobStore(baseJobRow({ mode: "FULL", startedAt: "2026-09-12T00:00:00.000Z", lastSuccessfulSyncAt: previousBasis }));
  resetZaicoApi([{ items: [makeZaicoItem({ id: 900 })], hasMore: false }]);
  rejectNextCompletionWrite = true;

  await handler(testOverrides);

  assertEqual(jobStore?.status, "RUNNING", "保存拒否: COMPLETED書き込み自体が失敗したのでstatusはRUNNINGのまま(半端に書き換わっていない)");
  assertEqual(
    jobStore?.lastSuccessfulSyncAt,
    previousBasis,
    "保存拒否: checkpoint保存が失敗した回、基準は前進していない(単一UpdateCommandの原子性)",
  );
  assertTrue(typeof jobStore?.lastError === "string", "保存拒否: 失敗がlastErrorへ記録され、次のtickでADMINが状況を確認できる");
}

/* ══════════════════════════════════════════════════════════════════
 * 4g. UI経路(advanceOnePage、zaicoBackgroundSync.ts)の複数advance:
 *    実DynamoDB/実Amplifyには依存しない純粋関数レベルで、「UIの
 *    “今すぐ1ページ進める”ボタンを何回も押す」状況を模す。advanceOnePage
 *    自体はAmplify Data Client(serverDataClient)を直接掴んでおり、この
 *    境界試験のDynamoDBモックでは差し替えられない(ファイル冒頭コメント
 *    参照)——advanceOnePageがworker経路(runSyncWorker)と全く同じ
 *    trusted計算(parseFailedRetryIds→nextFailedSourceIdsTrusted→
 *    hasUncapturedLegacyFailures→resolveNextSyncBasis)を使っていることは
 *    scripts/verify-zaico-sync-error-surfacing.tsのソース検査で別途
 *    担保しているので、ここではその計算そのものを複数回の“advance”に
 *    見立てて反復し、途中の書き込みがtrustedを誤って進めないことを検証する。
 * ══════════════════════════════════════════════════════════════════ */
function testUiMultipleAdvancesDoNotLeakTrustAcrossPartialWrites() {
  // advance 1回目: 旧RUNNING job相当。failedSourceIds未設定(trusted:false)、
  // 既存failedが1件。このページでは新規の失敗は起きない。
  let stored: unknown = undefined;
  let { ids, trusted } = parseFailedRetryIds(stored);
  assertEqual(trusted, false, "UI複数advance 1回目: 未設定はtrusted:false");
  const legacyFailedCount = 1;
  // このページはDELTA(since!=null)で、まだ完了していない(isDone=false)。
  stored = serializeFailedRetryState(ids, nextFailedSourceIdsTrusted(trusted, "2026-09-01T00:00:00.000Z", false));
  ({ ids, trusted } = parseFailedRetryIds(stored));
  assertEqual(trusted, false, "UI複数advance 1回目書き込み後: 未完了の中間書き込みではtrustedにならない");

  // advance 2回目: 同じジョブの続き。まだisDone=falseのページがもう1回。
  stored = serializeFailedRetryState(ids, nextFailedSourceIdsTrusted(trusted, "2026-09-01T00:00:00.000Z", false));
  ({ ids, trusted } = parseFailedRetryIds(stored));
  assertEqual(trusted, false, "UI複数advance 2回目書き込み後: 何度中間書き込みを重ねてもtrustedへ昇格しない");

  // advance 3回目: このページでページが完走(isDone=true)、DELTAのまま。
  stored = serializeFailedRetryState(ids, nextFailedSourceIdsTrusted(trusted, "2026-09-01T00:00:00.000Z", true));
  ({ ids, trusted } = parseFailedRetryIds(stored));
  assertEqual(trusted, false, "UI複数advance 3回目(DELTA完了): DELTAの完了はsince!==nullなのでtrustedにならない");
  assertTrue(
    hasUncapturedLegacyFailures(trusted, legacyFailedCount),
    "UI複数advance 3回目後: このジョブ行が最初に持っていたfailedCount分は、まだ捕捉保証が無いまま(基準前進はUI側でも見送られるべき)",
  );

  // advance 4回目: 管理者がFULLへ切り替えて新規ジョブを開始し、1ページで完走。
  stored = serializeFailedRetryState(new Set(), nextFailedSourceIdsTrusted(false, null, true));
  ({ ids, trusted } = parseFailedRetryIds(stored));
  assertEqual(trusted, true, "UI複数advance 4回目(FULL完了): since===nullを伴う完了でtrusted化される");
  assertTrue(!hasUncapturedLegacyFailures(trusted, 0), "UI複数advance 4回目後: 新規ジョブはfailedCount0なので基準前進を妨げない");
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
  await testPartialFailureAdvancesBasisAndQueuesRetry();
  await testLegacyRunningJobWithUncapturedFailuresBlocksBasisAdvance();
  await testLegacyRunningJobUncapturedFailureSurvivesAcrossCheckpoints();
  await testCorruptedFailedSourceIdsBlocksBasisAdvance();
  await testFreshJobWithNoFailuresAdvancesBasisNormally();
  await testCompletionCheckpointFailureDoesNotAdvanceBasis();
  testUiMultipleAdvancesDoNotLeakTrustAcrossPartialWrites();
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
