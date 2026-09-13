/**
 * EC一覧の段階別サーバー待ち時間計測(2026-09-13 「EC計測レビュー補正」)
 * が正しいことの検証 ── 計測の基盤(lib/perf/queryTiming.ts)と診断応答
 * の組み立て(lib/listing/listingsOverviewTimingResponse.ts)を、実物の
 * まま(mock無しで)呼び出して確認する。
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-listings-overview-timing.ts
 *
 * ── なぜmockもregisterHooksも要らないか ─────────────────────────
 *
 * `lib/perf/queryTiming.ts`はnode:async_hooks以外に依存しない葉モジュール。
 * `lib/listing/listingsOverviewTimingResponse.ts`もそこから
 * `getStageTimings`/`isQueryTimingEnabled`を読み込むだけで、
 * `@/lib/listing/service`へは型(`import type`)としてのみ依存する ──
 * 型importは実行時に消えるので、この2ファイルは`server-only`/next/
 * headers/AWS SDKへ実際には触れない。そのため
 * `scripts/verify-listings-overview-service-boundary.ts`のような
 * モジュール解決フック(registerHooks)や外部パッケージのスタブが無くても
 * tsxだけで直接importできる。
 *
 * `lib/listing/service.ts`本体(実際に4本の並列読み取りを束ねる配線、
 * 実mockでのページtoken/失敗の伝播)は上記の理由でここではimportできない
 * ため、`scripts/verify-listings-overview-service-boundary.ts`(既存の
 * mock経路)側で検証する。
 *
 * ── 何を検証するか ──────────────────────────────────────────────
 *
 * 1. `measureStage`が返す`elapsedMs`は「その1本の処理」の壁時計経過
 *    時間であり、`groupTimingsByOp`が返す累積ms(model.opへの複数往復を
 *    単純合計した値)とは別物であること ── 並列に走る複数の往復が
 *    ある場合、累積msは壁時計より大きくなり得ることを実際に待つ合成
 *    遅延(setTimeout)で示す。数値を演算で埋めた自己申告のテストに
 *    しない。
 * 2. 計測が既定(無効)のとき、`withQueryTiming`が記録を一切残さず、
 *    戻り値・例外を変えないこと。
 * 3. `attachStageTimings`/`getStageTimings`が、例外の型・message・
 *    instanceofを変えずに段階別計測を運べること。
 * 4. 同時に走る2つの`withQueryTiming`呼び出しが、互いの記録を汚染
 *    しないこと(AsyncLocalStorageによる分離 ── 2026-09-13 レビュー
 *    「同時要求分離」)。
 * 5. 診断応答の組み立て(`buildTimingResponsePayload`)が:
 *    - ゲートOFF(`BELLO_QUERY_TIMING`未設定)では実データへ一切触れず
 *      `{ enabled: false }`だけを返すこと(2026-09-13 レビュー
 *      「ゲートOFF無取得」)。
 *    - 成功時は`stages`/`queryTotals`/`totalMs`をそのまま返すこと。
 *    - 失敗時、元の例外メッセージ・スタック・AWS識別子を含めず、
 *      `getStageTimings`で拾える段階別計測(固定ラベル・経過時間・
 *      成否)だけを返すこと(2026-09-13 レビュー「fetchがthrowすると
 *      計測結果を組み立てず、診断GETは汎用errorのみで失敗段階が消える」
 *      の是正)。
 */
import fs from "node:fs";
import path from "node:path";

let passes = 0;
let failures = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 1. elapsedMs(壁時計)と累積ms(groupTimingsByOp)の区別
 *
 * 1つの段階の内部で、同じmodel.opへ2回「並列に」往復するケース(GSI
 * を対象カテゴリごとにPromise.allで並列に叩くlistEcEligibleInventoryと
 * 同じ形)。壁時計(measureStageのelapsedMs)は「並列に走った分の最大」
 * に近く、累積ms(groupTimingsByOp)は単純合計になる ── 前者が段階の
 * 実際の待ち時間、後者はDB往復の総量という別の参考値であることを、
 * 実際に待つ合成遅延(setTimeout)で示す。数値を演算で埋めた自己申告の
 * テストにしない。
 * ══════════════════════════════════════════════════════════════════ */
async function testStageElapsedIsWallClockNotSum() {
  process.env.BELLO_QUERY_TIMING = "1";
  const { measureStage, recordQuery, currentQueryTimings, groupTimingsByOp, withQueryTiming } = await import("@/lib/perf/queryTiming");

  const delayMs = 100;
  // groupTimingsByOpはAsyncLocalStorageのコンテキスト内(withQueryTimingで
  // 囲まれている間)でしか記録を読めない ── measureStageの外側まで出てから
  // 呼ぶと空になる(実際にこの間違いを一度実測して踏んだ)。cumulativeも
  // 段階の中で読む。
  const { outcome, cumulative } = await withQueryTiming("test-parallel-stage-2", async () => {
    const outcome = await measureStage("stage", async () => {
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          recordQuery({ model: "M", op: "op", ms: delayMs, items: 1 });
        })(),
        (async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          recordQuery({ model: "M", op: "op", ms: delayMs, items: 1 });
        })(),
      ]);
    });
    return { outcome, cumulative: groupTimingsByOp(currentQueryTimings()).find((g) => g.key === "M.op") };
  });

  ok(outcome.ok === true, "並列2本とも成功すればok=true");
  ok(
    outcome.timing.elapsedMs < delayMs * 1.6,
    `段階のelapsedMsは並列実行の壁時計(≒${delayMs}ms)に近く、累積msの単純合計(≒${delayMs * 2}ms)にはならない(実測${outcome.timing.elapsedMs}ms)`,
  );
  ok(!!cumulative && cumulative.ms >= delayMs * 1.8, `一方で累積ms(参考値)は単純合計のまま(実測${cumulative?.ms}ms) — 両者は別の数字として区別して返す`);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 計測が既定(無効)のとき、何もしない契約
 * ══════════════════════════════════════════════════════════════════ */
async function testDisabledIsNoop() {
  delete process.env.BELLO_QUERY_TIMING;
  const { withQueryTiming, recordQuery, currentQueryTimings, isQueryTimingEnabled } = await import("@/lib/perf/queryTiming");

  ok(isQueryTimingEnabled() === false, "既定(BELLO_QUERY_TIMING未設定)は無効");

  let ran = false;
  const value = await withQueryTiming("test-screen-disabled", async () => {
    ran = true;
    recordQuery({ model: "X", op: "y", ms: 999, items: 1 });
    return 42;
  });
  ok(ran, "無効時もfn自体はそのまま呼ばれる(戻り値・例外を変えない契約)");
  ok(value === 42, "無効時、戻り値がそのまま返る");
  ok(currentQueryTimings().length === 0, "無効時は記録が一切残らない(囲まれていないため)");
}

/* ══════════════════════════════════════════════════════════════════
 * 3. attachStageTimings/getStageTimings ── 例外の型・messageを変えない
 * ══════════════════════════════════════════════════════════════════ */
async function testStageTimingsRoundTrip() {
  const { attachStageTimings, getStageTimings } = await import("@/lib/perf/queryTiming");

  const original = new Error("ChannelListing scan failed: table=bello-prod-XYZ");
  const stages = [
    { stage: "ecEligibleInventory", elapsedMs: 42, ok: true },
    { stage: "channelListings", elapsedMs: 7, ok: false },
  ];
  const tagged = attachStageTimings(original, stages);

  ok(tagged === original, "attachStageTimingsは元のオブジェクトそのものへ付加する(型を変えない)");
  ok(tagged instanceof Error, "instanceof Error のまま");
  ok((tagged as Error).message === original.message, "messageは変わらない");
  ok(JSON.stringify(getStageTimings(tagged)) === JSON.stringify(stages), "getStageTimingsで元の段階別計測を取り出せる");

  ok(getStageTimings(new Error("no stages attached")).length === 0, "付加されていない例外はgetStageTimingsが空配列を返す(段階情報が無いだけで失敗自体は分かる)");
  ok(getStageTimings("some string thrown").length === 0, "オブジェクトでない値(文字列throw等)を渡してもクラッシュせず空配列");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 同時要求分離(AsyncLocalStorageによる分離)
 * ══════════════════════════════════════════════════════════════════ */
async function testConcurrentRequestIsolation() {
  process.env.BELLO_QUERY_TIMING = "1";
  const { withQueryTiming, recordQuery, currentQueryTimings } = await import("@/lib/perf/queryTiming");

  const seenByA: number[] = [];
  const seenByB: number[] = [];

  await Promise.all([
    withQueryTiming("request-A", async () => {
      recordQuery({ model: "A", op: "x", ms: 10, items: 1 });
      // Bの処理が間に割り込む時間を作る。
      await new Promise((r) => setTimeout(r, 30));
      recordQuery({ model: "A", op: "y", ms: 20, items: 1 });
      seenByA.push(currentQueryTimings().length);
    }),
    withQueryTiming("request-B", async () => {
      recordQuery({ model: "B", op: "z", ms: 5, items: 1 });
      seenByB.push(currentQueryTimings().length);
      await new Promise((r) => setTimeout(r, 10));
      seenByB.push(currentQueryTimings().length);
    }),
  ]);

  ok(seenByA[0] === 2, `★要件: 同時に走るrequest-Aの計測はrequest-Bの記録を含まない(2本のみ、実測${seenByA[0]}本)`);
  ok(seenByB[0] === 1 && seenByB[1] === 1, `★要件: request-Bの計測もrequest-Aの記録に汚染されない(常に自分の1本のみ、実測${JSON.stringify(seenByB)})`);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 診断応答(buildTimingResponsePayload)
 * ══════════════════════════════════════════════════════════════════ */
async function testBuildTimingResponsePayload() {
  const { buildTimingResponsePayload } = await import("@/lib/listing/listingsOverviewTimingResponse");

  // ★要件: ゲートOFF(BELLO_QUERY_TIMING未設定)では実データへ一切触れない。
  {
    delete process.env.BELLO_QUERY_TIMING;
    let called = false;
    const { status, body } = await buildTimingResponsePayload(async () => {
      called = true;
      return { stages: [], queryTotals: [], totalMs: 0 };
    });
    ok(status === 200 && body.enabled === false, "ゲートOFF時は{enabled:false}のみを返す");
    ok(!called, "★要件: ゲートOFF時はloadTimedOverviewを一切呼ばない(一覧の読み取りを発生させない)");
  }

  process.env.BELLO_QUERY_TIMING = "1";

  // 成功時: stages/queryTotals/totalMsをそのまま返す。
  {
    const stages = [{ stage: "ecEligibleInventory", elapsedMs: 12, ok: true }];
    const queryTotals = [{ key: "Inventory.listInventoryByCategoryId", pages: 2, ms: 20, ok: true }];
    const { status, body } = await buildTimingResponsePayload(async () => ({ stages, totalMs: 15, queryTotals }));
    ok(status === 200 && body.enabled === true, "成功時はenabled:trueで200");
    ok(JSON.stringify(body.stages) === JSON.stringify(stages), "段階別計測をそのまま返す");
    ok(JSON.stringify(body.queryTotals) === JSON.stringify(queryTotals), "累積参考値もそのまま返す");
  }

  // 失敗時: 元のメッセージ/スタックは含めず、段階別計測(あれば)だけ返す。
  {
    const { attachStageTimings } = await import("@/lib/perf/queryTiming");
    const secretMessage = "DynamoDB table bello-inventory-prod-XYZ123: ConditionalCheckFailedException at arn:aws:dynamodb:...";
    const failingStages = [
      { stage: "ecEligibleInventory", elapsedMs: 88, ok: false },
      { stage: "channelListings", elapsedMs: 12, ok: true },
    ];
    const throwingLoad = async (): Promise<never> => {
      throw attachStageTimings(new Error(secretMessage), failingStages);
    };

    const { status, body } = await buildTimingResponsePayload(throwingLoad);
    const serialized = JSON.stringify(body);

    ok(status === 500, "例外時はHTTP 500を返す");
    ok(body.error === "listings_overview_failed", "例外時は種別ラベルだけを返す");
    ok(!serialized.includes(secretMessage), "応答に元の例外メッセージが含まれない");
    ok(!serialized.includes("DynamoDB") && !serialized.includes("arn:aws"), "応答にAWS/テーブル名等の断片が含まれない");
    ok(!("stack" in body), "応答にスタックトレースを含めない");
    ok(
      JSON.stringify(body.stages) === JSON.stringify(failingStages),
      "★要件: 失敗時も固定段階名/経過時間/成否は読み取れる(以前は汎用errorのみで失敗段階が消えていた)",
    );
    ok(!("rows" in body), "応答にrows(一覧の行)を含めない");
  }

  // 段階情報が無い例外(measureStage経由でない失敗)でも500自体は返る。
  {
    const { status, body } = await buildTimingResponsePayload(async () => {
      throw new Error("unexpected");
    });
    ok(status === 500 && body.error === "listings_overview_failed", "段階情報の無い例外でも失敗種別は返す");
    ok(Array.isArray(body.stages) && (body.stages as unknown[]).length === 0, "段階情報が無ければ空配列(クラッシュしない)");
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 配線の静的確認 ── listListingsOverviewが二重実装になっていないこと
 * ══════════════════════════════════════════════════════════════════ */
function testWiring() {
  const repoRoot = process.cwd();
  const src = fs.readFileSync(path.join(repoRoot, "lib/listing/service.ts"), "utf8");

  ok(
    /export async function listListingsOverview\(\): Promise<ListingOverviewRow\[\]> \{[\s\S]*?const \{ rows \} = await listListingsOverviewWithTiming\(\);/.test(
      src,
    ),
    "listListingsOverviewはlistListingsOverviewWithTiming経由になっている(二重実装ではない)",
  );
  ok(src.includes('withQueryTiming("listings-overview"'), "EC一覧の読み取りがwithQueryTimingで計測に組み込まれている");
  ok(src.includes("isQueryTimingEnabled()"), "計測が有効なときだけ段階計測つきの経路を通る(既定は素通り)");
  ok(src.includes("measureStage("), "壁時計の段階計測(measureStage)を使っている");

  const stageIface = /interface ListingsOverviewStageTiming \{([\s\S]*?)\}/.exec(src);
  ok(!!stageIface, "ListingsOverviewStageTiming の型定義が見つかる");
  if (stageIface) {
    const body = stageIface[1];
    const fields = ["stage: string", "elapsedMs: number", "ok: boolean"];
    ok(fields.every((f) => body.includes(f)), "計測結果の型が段階名/経過時間/成否だけ(商品・顧客・認証情報のフィールドが無い)");
  }

  const routeSrc = fs.readFileSync(path.join(repoRoot, "app/api/inventory/listings-overview-timing/route.ts"), "utf8");
  ok(routeSrc.includes("getInventoryRole"), "診断エンドポイントが画面と同じ閲覧権限でゲートされている");
  ok(
    /const role = await getInventoryRole\(\);\s*if \(!role\)[\s\S]*?buildTimingResponsePayload/.test(routeSrc),
    "★要件: 権限チェック(401)がbuildTimingResponsePayload呼び出しより先に行われる",
  );
  ok(routeSrc.includes("buildTimingResponsePayload"), "診断エンドポイントの応答本体組み立てがbuildTimingResponsePayload経由になっている");
  ok(!routeSrc.includes(".rows"), "診断エンドポイントの応答にrows(一覧の行)を含めていない");
  ok(routeSrc.includes("no-store"), "診断エンドポイントの応答がno-storeを維持している");
}

async function main() {
  await testStageElapsedIsWallClockNotSum();
  await testDisabledIsNoop();
  await testStageTimingsRoundTrip();
  await testConcurrentRequestIsolation();
  await testBuildTimingResponsePayload();
  testWiring();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
