import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { listInventories } from "./zaicoApiClient";
import { createLambdaSyncPort, findMissingZaicoManagedInventory } from "./lambdaSyncPort";
import { syncPendingItemsWithDelta, mergeDeltaPageCounts, type DeltaPageCounts } from "@/lib/inventory/zaicoSyncPageProcessor";
import {
  resolveNextSyncBasis,
  nextFailedRetryIds,
  parseFailedRetryIds,
  hasUncapturedLegacyFailures,
  serializeFailedRetryState,
  nextFailedSourceIdsTrusted,
} from "@/lib/inventory/zaicoDelta";
import { ZAICO_SYNC_JOB_ID } from "../../../lib/inventory/zaicoSyncJobId";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期の完全無人worker。
 * resource.tsのコメント参照。ZaicoSyncJobの既存singleton行
 * (lib/inventory/zaicoBackgroundSync.tsが定義するのと全く同じid/
 * フィールド)をそのまま共有する——ブラウザ側の「今すぐ少し進める」
 * advance操作とこのLambdaのスケジュール実行は、同じjob行をlease機構
 * で安全に排他する。
 *
 * ── 2026-09-11 設計見直し: 差分同期をこの経路にも適用 ─────────────
 *
 * このLambdaが5分毎に無人で本番を回している唯一の経路
 * (resource.tsコメント: ブラウザを閉じてもPCの電源を落としても最後まで
 * 進む)。ところがこれまでは`lib/inventory/zaicoBackgroundSync.ts`が
 * 実装していた`splitByDelta`(前回成功時刻以降だけを実処理する差分
 * 同期)を一切使わず、`seenSourceIds`以外の全件に`syncOneZaicoItem`を
 * 呼んでいた——差分同期の効果は、本番で常時稼働しているこの経路には
 * 一度も適用されていなかった(ADMINが手動で押す「今すぐ1ページ進める」
 * ボタンでしか効いていなかった)。`lib/inventory/zaicoSyncPageProcessor.ts`
 * へ切り出した共通ロジックで、両経路が同じ判定を使うようにする。
 *
 * ── 2026-09-12 追記: BELLO未取込・古い時刻の商品が永久skipされる穴を閉じる ──
 *
 * 上の初版は「対象0件のページではfetchAllZaicoManaged(Inventory全件
 * Scan相当)自体を呼ばない」という最適化を持っていたが、これは
 * 「時刻だけを見てskipしてよいと判定された商品は、本当にBELLOへ
 * 既に取り込まれている」という前提に依存していた。この前提が崩れる
 * ケース(何らかの理由でBELLOに一度も取り込まれないまま残った商品の
 * ZAICO側updated_atがたまたま古い)では、`since`がその商品のupdated_at
 * より進んでいる限り**永久に**skipされ続け、自然には回復しない
 * (lib/inventory/zaicoDelta.tsのsplitByDeltaコメント参照)。
 *
 * 直し方: `port.fetchAllZaicoManaged()`をページ毎ではなく**この
 * invocation(1回のLambda呼び出し)につき1回だけ**呼び、その結果の
 * Mapを全ページの`syncPendingItemsWithDelta`呼び出しへ使い回す。
 * これにより「時刻だけならskip」と判定された商品についても、実際に
 * BELLOに存在するかをMapの.hasでタダ(O(1))で確認でき、存在しない
 * ものは古い時刻でも取りこぼさず処理側へ回せる。副次効果として、
 * 1 invocationあたりのInventory全件Scan回数は「変更ありページの数」
 * から「高々1回」へさらに減る(旧設計は変更ありページが複数あれば
 * その数だけScanしていた)。
 *
 * ── 2026-09-12 task_1606b70追記: prefetchはtryブロックの内側で呼ぶ ──
 *
 * 上記のprefetch(`port.fetchAllZaicoManaged()`)を1 invocationにつき
 * 1回に減らす変更(task_a320)は、当初この呼び出しを`try`の**外側**
 * (=lease確保直後、pagesThisRunの前)に置いていた。これは既存の
 * `catch`(retryCount記録・一定回数超でFAILED化)と`finally`
 * (releaseLease)のどちらも素通りしてしまう——prefetch自体がDynamoDB
 * 障害などで例外を投げると、リトライの痕跡が一切残らないまま
 * (retryCountが上がらない)、かつlease解放もされないまま関数が
 * 終了する。lease未解放は`LEASE_DURATION_MS`(4分)の自然失効までは
 * 他の実行主体(ブラウザの「今すぐ1ページ進める」やこのLambda自身の
 * 次tick)を排他し続ける、という「失敗を隠す」退行になる。
 * 直し方は1行の移動のみ: この呼び出しを`try`の内側(ループの前)へ
 * 移し、他の全ての`await`と同じく失敗時にcatch/finallyを必ず通す
 * ようにする。`scripts/verify-zaico-worker-boundary.ts`の
 * 「prefetch例外」シナリオがこの回帰を再現・固定する。
 *
 * ── 2026-09-14 task_23b5395c49434d58b8: 恒久失敗が基準を永久固着させる不具合 ──
 *
 * 「1件でもfailedがあった回は基準を進めない」(resolveNextSyncBasis)は
 * 一時的な失敗には正しいが、ある商品が**恒久的に**(データ不整合等、
 * 再試行しても直らない理由で)失敗し続けると、基準が永久にnullのまま
 * 固着する——「差分同期が毎回『初回のため全件』になる」不具合の根本
 * 原因(lib/inventory/zaicoDelta.tsのresolveNextSyncBasis/
 * nextFailedRetryIdsコメント参照)。
 *
 * 直し方: 失敗した商品のsourceIdを`ZaicoSyncJob.failedSourceIds`へ
 * 永続化し(`nextFailedRetryIds`)、次回以降`syncPendingItemsWithDelta`
 * 経由で基準に関係なく強制的に再試行する。これにより恒久失敗の商品は
 * 成功するまで取りこぼされず、かつ他の正常な商品の基準前進を妨げない。
 *
 * ── 2026-09-14 移行安全性: この機能が入る前から実行中だったジョブ ────
 *
 * 上記の前提(「failedはfailedSourceIdsで捕捉されている」)は、この
 * フィールドが導入される**前から実行中(RUNNING)だった**ジョブでは
 * 成り立たない——そのジョブが既に`failed`カウントを積んでいた(旧
 * コードのもとで発生した失敗)にも関わらず、failedSourceIds自体は
 * まだ一度も書かれていない(`undefined`)ため、旧失敗のsourceIdは
 * このリトライ集合に一度も入らない。にも関わらず完了時に基準を前進
 * させると、その旧失敗商品は基準前進後の時刻ベース判定で永久にskip
 * され、恒久失敗リストにも載っていないので強制再試行の対象にもならず、
 * 取りこぼしたまま気づけなくなる。
 *
 * `parseFailedRetryIds`は未設定/破損時を`trusted: false`として区別し、
 * `hasUncapturedLegacyFailures(trusted, 今回までのfailedカウント)`が
 * `true`の回だけ`resolveNextSyncBasis`の第4引数へ`true`を渡して基準
 * 前進を止める——次回、同じ(前進していない)基準で安全にもう一度
 * スキャンされる。
 *
 * ── 2026-09-14 (task_ff42042dfee35233e9) checkpoint跨ぎの再修正 ─────
 *
 * 上記だけでは、1 invocationでジョブが完了しない(ページ内時間切れ・
 * ページ跨ぎで複数回のLambda invocationにまたがる)場合に穴が残って
 * いた: 中間(RUNNING)checkpointも`failedSourceIds`を毎回書き込むため、
 * 「配列としてparseできる=trusted」という判定だと、まだ旧failedを
 * 一切再捕捉していない段階の中間checkpoint(中身が空でも)が次回
 * invocationから`trusted: true`と誤認され、`hasUncapturedLegacyFailures`
 * がfalseになって基準を前進させてしまう。`trusted`は`nextFailedSourceIdsTrusted`
 * (lib/inventory/zaicoDelta.ts)の判定に従い、`serializeFailedRetryState`
 * で書き込む値そのものに明示的に運ぶ——「一度trustedならsticky、まだ
 * なら`since === null`を伴う完了のときだけ新たにtrusted化」という
 * ルールに変え、DELTAの途中/完了ではtrusted化しないようにした。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ZAICO_SYNC_JOB_TABLE = process.env.ZAICO_SYNC_JOB_TABLE_NAME!;
const JOB_ID = ZAICO_SYNC_JOB_ID;
const ITEMS_PER_PAGE = 50;
const LEASE_DURATION_MS = 4 * 60 * 1000; // 4分——Lambda自体のtimeout(240秒)より短く、他の実行主体が「lease切れ」と判定できる猶予を作る
const TIME_BUDGET_MS = 210_000; // 240秒timeoutに対し、最後のcheckpoint書き込み分の余裕を30秒残す
const MAX_RETRIES_BEFORE_FAILED = 5;

const OWNER_ID = `lambda:${randomUUID().slice(0, 8)}`;

function parseSeenSourceIds(raw: unknown): Set<string> {
  if (typeof raw === "string") {
    try {
      return parseSeenSourceIds(JSON.parse(raw));
    } catch {
      return new Set();
    }
  }
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

interface JobRow {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  lastPage?: number;
  totalProcessed?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  failed?: number;
  imageImported?: number;
  seenSourceIds?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  retryCount?: number;
  // ── 差分同期(lib/inventory/zaicoBackgroundSync.tsのstartZaicoBackgroundSyncJob
  // が書き込む。このLambdaは読むだけ——modeやsyncSinceは実行の途中で
  // 変えない) ──────────────────────────────────────────────────────
  startedAt?: string;
  mode?: "DELTA" | "FULL";
  syncSince?: string | null;
  skippedByDelta?: number;
  lastSuccessfulSyncAt?: string | null;
  /** task_23b5395c49434d58b8: 恒久失敗リスト。ファイル冒頭コメント参照。 */
  failedSourceIds?: string;
}

async function getJob(): Promise<JobRow | null> {
  const { Item } = await ddb.send(new GetCommand({ TableName: ZAICO_SYNC_JOB_TABLE, Key: { id: JOB_ID } }));
  return (Item as JobRow | undefined) ?? null;
}

/**
 * lease確保。既にleaseOwnerが別の主体(自分以外)で、かつまだ有効期限内
 * なら失敗(false)を返す——ブラウザ側のadvanceZaicoBackgroundSyncJobが
 * ちょうど同じjobを処理中なら、このLambda実行は今回何もせず終了する
 * (次の5分後に再挑戦、コストは1回のGetItem+条件付きUpdateItemのみ)。
 */
async function claimOrRenewLease(): Promise<boolean> {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ZAICO_SYNC_JOB_TABLE,
        Key: { id: JOB_ID },
        UpdateExpression: "SET leaseOwner = :owner, leaseExpiresAt = :expires, lastHeartbeatAt = :now",
        ConditionExpression: "attribute_not_exists(leaseOwner) OR leaseExpiresAt < :nowStr OR leaseOwner = :owner",
        ExpressionAttributeValues: { ":owner": OWNER_ID, ":expires": leaseExpiresAt, ":now": now, ":nowStr": now },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** 自分が保持しているleaseだけを解放する(他の実行主体が既に新しいleaseを確保していたら誤って奪わないよう、ConditionExpressionでowner一致を確認)。 */
async function releaseLease(): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ZAICO_SYNC_JOB_TABLE,
        Key: { id: JOB_ID },
        UpdateExpression: "REMOVE leaseOwner, leaseExpiresAt",
        ConditionExpression: "leaseOwner = :owner",
        ExpressionAttributeValues: { ":owner": OWNER_ID },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") console.error("[zaico-sync-worker] failed to release lease (non-fatal):", err);
  }
}

async function writeCheckpoint(fields: Record<string, unknown>): Promise<void> {
  const names = Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(Object.values(fields).map((v, i) => [`:v${i}`, v]));
  const setClause = Object.keys(fields).map((_, i) => `#f${i} = :v${i}`).join(", ");
  await ddb.send(new UpdateCommand({ TableName: ZAICO_SYNC_JOB_TABLE, Key: { id: JOB_ID }, UpdateExpression: `SET ${setClause}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}

/**
 * 2026-09-12 task_1606b70: 実handler境界試験(scripts/
 * verify-zaico-worker-boundary.ts)のための最小限の差替え口。
 *
 * Node ESM(tsxの実行環境)は名前付きexportをlive-bindingの
 * 非configurableプロパティとして公開するため、`./zaicoApiClient`や
 * `./lambdaSyncPort`のexportをテスト側から外部書き換えすることが
 * できない(`Object.defineProperty`ですら`Cannot redefine property`
 * になる、実測)。そのため、この3つの外部境界(ZAICO API呼び出し・
 * port生成・missing判定)だけを**引数で任意に差し替え可能**にした
 * ——テストは共通処理`runSyncWorker`へ依存を渡す。
 * 公開Lambda `handler`はイベントを依存として渡さず、必ず実装へ
 * 接続する。外部イベントから依存を差し替えることはできない。
 * DynamoDB(ddb.send)側は`DynamoDBDocumentClient.prototype.send`の
 * prototype置換で足りる(クラスの実インスタンスなので外部から差替え
 * 可能)ため、こちらは引数化していない。
 */
export interface HandlerTestOverrides {
  listInventories?: typeof listInventories;
  createLambdaSyncPort?: typeof createLambdaSyncPort;
  findMissingZaicoManagedInventory?: typeof findMissingZaicoManagedInventory;
}

export const runSyncWorker = async (overrides?: HandlerTestOverrides) => {
  const listInventoriesFn = overrides?.listInventories ?? listInventories;
  const createLambdaSyncPortFn = overrides?.createLambdaSyncPort ?? createLambdaSyncPort;
  const findMissingZaicoManagedInventoryFn = overrides?.findMissingZaicoManagedInventory ?? findMissingZaicoManagedInventory;

  const job = await getJob();
  if (!job || (job.status !== "PENDING" && job.status !== "RUNNING")) {
    return { skipped: true, reason: "no PENDING/RUNNING job" };
  }

  const claimed = await claimOrRenewLease();
  if (!claimed) {
    console.log("[zaico-sync-worker] lease held by another executor (browser tab or overlapping invocation) — skipping this tick.");
    return { skipped: true, reason: "lease held elsewhere" };
  }

  const startTime = Date.now();
  const port = createLambdaSyncPortFn();

  let nextPage = (job.lastPage ?? 0) + 1;
  const seenSourceIds = parseSeenSourceIds(job.seenSourceIds);
  // task_23b5395c49434d58b8: 前回までに恒久的に失敗し続けているsourceId。
  // 基準(since)に関係なく強制的に再試行する(ファイル冒頭コメント参照)。
  const { ids: initialFailedRetryIds, trusted: failedSourceIdsTrusted } = parseFailedRetryIds(job.failedSourceIds);
  let failedRetryIds = initialFailedRetryIds;
  let counts: DeltaPageCounts = {
    totalProcessed: job.totalProcessed ?? 0,
    created: job.created ?? 0,
    updated: job.updated ?? 0,
    unchanged: job.unchanged ?? 0,
    failed: job.failed ?? 0,
    imageImported: job.imageImported ?? 0,
    skippedByDelta: job.skippedByDelta ?? 0,
  };
  // task_8ff5754e48711a753a: このinvocation開始時点(=旧コードが積んだ
  // 可能性のある分も含む)の累積failedカウント。isDone到達時、
  // failedSourceIdsが導入前から実行中だったジョブ(trusted: false)で
  // これが1件以上あれば、捕捉保証の無い既存失敗として基準前進を止める
  // (ファイル冒頭「移行安全性」コメント参照)。
  const initialFailedCount = counts.failed;

  // 実行の途中でmode/syncSinceは変わらない(browser側のstartZaicoBackgroundSyncJob
  // が開始時に決めたもの)ので、ループの外で1回だけ解決する。既存行に
  // modeが無ければ("FULL"でも無ければ)全件相当として扱う——
  // lib/inventory/zaicoBackgroundSync.tsのadvanceOnePageと全く同じ規約。
  const since = job.mode === "FULL" ? null : (job.syncSince ?? null);

  let pagesThisRun = 0;
  try {
    // 2026-09-12 task_1606b70: 「BELLOに既に存在するZAICO連携商品」の
    // Mapは、このinvocation内では1回だけ取得して使い回す
    // (zaicoSyncPageProcessor.ts冒頭コメント参照)。ページ毎に取り直さ
    // ない——時刻だけでskip候補になった商品もこのMapで安価に実在確認
    // できるので、対象0件のページでScanを避けるという旧最適化より強い
    // 削減(invocationあたり高々1回)になる。
    //
    // **この呼び出しは必ずtryの内側に置く**(ファイル冒頭コメント
    // 「prefetchはtryブロックの内側で呼ぶ」参照)。外側だと、この呼び
    // 出し自体が例外を投げたときにcatch(retryCount記録)にもfinally
    // (releaseLease)にも到達せず、失敗の痕跡もlease解放も残らない。
    const existingBySourceId = await port.fetchAllZaicoManaged();

    for (;;) {
      // §14.3(第五ラウンド仕様): チェックポイント/status write自体が
      // ボトルネックにならない粒度——ページ単位(最大50件)で1回だけ。
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        console.log(`[zaico-sync-worker] time budget reached after ${pagesThisRun} page(s) this invocation — yielding to next scheduled tick.`);
        break;
      }

      const { items: zaicoItems, hasMore } = await listInventoriesFn(nextPage, ITEMS_PER_PAGE);

      // leaseを更新(heartbeat)——1ページ処理する間にlease有効期限が
      // 切れないよう、ページ毎に延長する。
      const stillLeased = await claimOrRenewLease();
      if (!stillLeased) {
        console.warn("[zaico-sync-worker] lost lease mid-run (unexpected) — stopping cleanly, checkpoint already reflects only fully-processed pages.");
        break;
      }

      // 1ページが1,000件になったことへの対応。
      //
      // ZAICOは per_page を無視して常に1,000件返す(実測)。以前は
      // hasMoreの判定が壊れていて1ページ目で終わっていたため表面化して
      // いなかったが、それを直すと1回の呼び出しで1,000件を処理しようと
      // してLambdaの実行時間を超えうる。特に新規登録は画像取り込みを
      // 伴うので1件あたりの時間が長い。
      //
      // ページ内の途中で時間切れになったら、lastPageを進めずに
      // checkpointだけ書いて次回の呼び出しへ譲る。次回は同じページを
      // 取り直し、seenSourceIdsに入っている分を飛ばして続きから進む。
      // seenSourceIdsは元から再開時に読み込まれているので、スキーマを
      // 変えずにページ内再開が成立する。
      //
      // 2026-09-01→2026-09-11: 「前回までに処理済み」だけでなく、
      // 「前回成功時刻以降変わっていない」ものもここで省く
      // (lib/inventory/zaicoSyncPageProcessor.ts参照)。
      const pending = zaicoItems.filter((item) => !seenSourceIds.has(String(item.id))); // 前回までに処理済み分を除く
      const outcome = await syncPendingItemsWithDelta(
        pending,
        since,
        "ZAICO同期(AWS Background Job)",
        port,
        () => Date.now() - startTime > TIME_BUDGET_MS,
        existingBySourceId,
        failedRetryIds,
      );
      for (const id of outcome.observedSourceIds) seenSourceIds.add(id);
      counts = mergeDeltaPageCounts(counts, outcome.counts);
      const budgetExhausted = outcome.budgetExhausted;
      // task_23b5395c49434d58b8: 実際に処理した分だけで恒久失敗リストを
      // 更新する(skipされた分は含まれない——nextFailedRetryIdsのコメント
      // 参照)。ページを跨いで蓄積し、各チェックポイントへ書き込む。
      failedRetryIds = nextFailedRetryIds(failedRetryIds, outcome.processedOutcomes);

      pagesThisRun += 1;

      if (budgetExhausted) {
        // ページの途中。lastPageは進めない(同じページを取り直して続ける)。
        const now = new Date().toISOString();
        await writeCheckpoint({
          status: "RUNNING",
          lastPage: nextPage - 1,
          ...counts,
          seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
          // task_ff42042dfee35233e9: 中間checkpointはisDone=falseで書く
          // ——「配列が書ければtrusted」に戻さない(ファイル冒頭コメント参照)。
          failedSourceIds: serializeFailedRetryState(failedRetryIds, nextFailedSourceIdsTrusted(failedSourceIdsTrusted, since, false)),
          updatedAt: now,
          retryCount: 0,
        });
        console.log(
          `[zaico-sync-worker] time budget reached mid-page ${nextPage} — checkpointed ${counts.totalProcessed} item(s); next invocation resumes within the same page.`,
        );
        break;
      }

      const isDone = !hasMore || zaicoItems.length === 0;
      const now = new Date().toISOString();

      if (isDone) {
        const missingSourceIds = await findMissingZaicoManagedInventoryFn(seenSourceIds);
        // task_23b5395c49434d58b8: 失敗した商品は`failedRetryIds`へ捕捉
        // 済み(次回以降、基準に関係なく強制再試行される)なので、通常は
        // 基準を前進させてよい——「1件でもfailedがあれば基準を止める」は
        // 恒久失敗1件が全件を道連れにする不具合の原因だったため廃止した。
        //
        // task_8ff5754e48711a753a: ただし「捕捉済み」と言えるのは
        // failedSourceIdsが信頼できる(trusted)ときだけ——この機能が
        // 導入される前から実行中だったジョブは、それ以前に積んだ
        // failedカウント(initialFailedCount)のsourceIdをどこにも
        // 持っていない。その場合だけ、基準前進を1回見送る
        // (hasUncapturedLegacyFailures/resolveNextSyncBasisのコメント
        // 参照)。
        const hadUnretriedFailures = hasUncapturedLegacyFailures(failedSourceIdsTrusted, initialFailedCount);
        const lastSuccessfulSyncAt = resolveNextSyncBasis(job.lastSuccessfulSyncAt ?? null, job.startedAt, now, hadUnretriedFailures);
        await writeCheckpoint({
          status: "COMPLETED",
          lastPage: nextPage,
          ...counts,
          seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
          // task_ff42042dfee35233e9: isDone=trueを渡す——trustedへ新たに
          // 昇格できるのは、このisDoneが「本物の全件完走」(since===null)
          // のときだけ(nextFailedSourceIdsTrustedのコメント参照)。
          failedSourceIds: serializeFailedRetryState(failedRetryIds, nextFailedSourceIdsTrusted(failedSourceIdsTrusted, since, true)),
          missingSourceIds,
          updatedAt: now,
          finishedAt: now,
          retryCount: 0,
          lastSuccessfulSyncAt,
        });
        console.log(
          `[zaico-sync-worker] job COMPLETED after ${pagesThisRun} page(s) this invocation. totalProcessed=${counts.totalProcessed} skippedByDelta=${counts.skippedByDelta} pendingRetry=${failedRetryIds.size}`,
        );
        break;
      }

      await writeCheckpoint({
        status: "RUNNING",
        lastPage: nextPage,
        ...counts,
        seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
        failedSourceIds: serializeFailedRetryState(failedRetryIds, nextFailedSourceIdsTrusted(failedSourceIdsTrusted, since, false)),
        updatedAt: now,
        retryCount: 0,
      });
      nextPage += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error(`[zaico-sync-worker] error at page ${nextPage}:`, err);
    const retryCount = (job.retryCount ?? 0) + 1;
    if (retryCount >= MAX_RETRIES_BEFORE_FAILED) {
      await writeCheckpoint({ status: "FAILED", lastError: message, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), retryCount });
      console.error(`[zaico-sync-worker] retryCount reached ${retryCount} — marking job FAILED (DLQ相当、ADMINが新規runを開始する必要がある).`);
    } else {
      // §14.3: 一時的な障害はcheckpointを進めず(lastPageは更新しない)、
      // 次のスケジュール実行で同じページから再試行する。exponential
      // backoffはスケジュール自体の5分間隔がそのまま担う。
      await writeCheckpoint({ retryCount, lastError: message, updatedAt: new Date().toISOString() });
    }
  } finally {
    await releaseLease();
  }

  return { pagesProcessed: pagesThisRun };
};

// Lambdaイベントをテスト用依存関係として解釈しない。
export const handler = async () => runSyncWorker();
