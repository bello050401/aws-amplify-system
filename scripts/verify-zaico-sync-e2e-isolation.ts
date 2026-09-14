/**
 * ZAICO候補3b3b8cd(持ち越し再試行/復旧スキャンの基準固着修正)QA:
 * 実ブラウザ・実ZaicoSyncPanel.tsxで安全に確認するために追加した
 * fixture境界(lib/inventory/zaicoSyncE2eFixtures.ts)の実境界試験。
 *
 * ── 何を証明するか ──────────────────────────────────────────────
 *
 * ZaicoSyncPanel.tsxはマウント時に`getZaicoBackgroundSyncStatusAction`を
 * 呼び、返ってきたジョブが PENDING/RUNNING ならその場で
 * `advanceZaicoBackgroundSyncAction`(実ZAICO API呼び出し)へ進む。
 * 本番のZaicoSyncJob singleton行を実ブラウザで直接見に行くと、この画面を
 * 開いただけで実際の同期が進んでしまう恐れがある——今回追加した
 * fixtureゲート(lib/inventory/zaicoBackgroundSync.tsの4関数冒頭の
 * isZaicoSyncE2EFixtureModeActive()ガード)が、この4関数のいずれからも
 * 実SDK(serverDataClient/listInventories)へ一切到達しないことを、
 * scripts/verify-settings-e2e-isolation.tsと同じ「OFFでまず到達を確認
 * →ONで0到達を確認」の対照設計で実証する。
 *
 * ── 技法 ────────────────────────────────────────────────────────
 *
 * scripts/verify-zaico-retry-persistence.tsのファイル冒頭コメントの
 * とおり、zaicoBackgroundSync.tsの依存チェーンはtsxのCJS
 * `Module._resolveFilename`経由で解決され、`node:module`の
 * `registerHooks`(ESM resolve hook)を経由しない——`createRequire`で
 * 得たrequireの`require.cache`へ直接mockを差し込む同じ技法を使う。
 * `next/headers`も同様の理由でcache注入する(lib/inventory/
 * zaicoSyncE2eFixtures.tsが`cookies()`を呼ぶため)。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-zaico-sync-e2e-isolation.ts
 */
import { createRequire } from "node:module";
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";

const cjsRequire = createRequire(import.meta.url);

function installMocks() {
  const dataClientMock = cjsRequire("./__mocks__/zaicoSyncE2EIsolation.dataClient.mock.cjs") as {
    __resetCalls: () => void;
    __setJobRow: (row: Record<string, unknown> | null) => void;
    __calls: unknown[];
  };
  const apiMock = cjsRequire("./__mocks__/zaicoSyncE2EIsolation.api.mock.cjs") as {
    __resetCalls: () => void;
    __calls: unknown[];
  };
  const nextHeadersMock = cjsRequire("./__mocks__/zaicoSyncE2EIsolation.nextHeaders.mock.cjs") as {
    __setScenarioCookie: (value: string | undefined) => void;
  };

  const inject = (specifier: string, exportsValue: unknown) => {
    const resolved = cjsRequire.resolve(specifier);
    cjsRequire.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue } as unknown as NodeJS.Module;
  };
  inject("@/lib/amplify/dataClient", dataClientMock);
  inject("@/lib/zaico/client", apiMock);
  inject("next/headers", nextHeadersMock);

  return { dataClientMock, apiMock, nextHeadersMock };
}

const { dataClientMock, apiMock, nextHeadersMock } = installMocks();

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

function resetSpies() {
  dataClientMock.__resetCalls();
  apiMock.__resetCalls();
}
function totalCalls(): number {
  return dataClientMock.__calls.length + apiMock.__calls.length;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=productionでは isE2EFixtureModeActive() が常にfalseになり、このテスト自体が意味を持たない");
  }

  const {
    getZaicoBackgroundSyncStatus,
    startZaicoBackgroundSyncJob,
    advanceZaicoBackgroundSyncJob,
    cancelZaicoBackgroundSyncJob,
  } = await import("@/lib/inventory/zaicoBackgroundSync");

  const originalFixtureFlag = process.env.INVENTORY_E2E_FIXTURES;

  console.log("── 比較対照(fixture OFF): 4関数が実際にSDK境界へ到達することをまず確認 ──");
  {
    delete process.env.INVENTORY_E2E_FIXTURES;
    dataClientMock.__setJobRow({
      id: ZAICO_SYNC_JOB_ID,
      status: "PENDING",
      mode: "DELTA",
      lastPage: 0,
      totalProcessed: 0,
      seenSourceIds: "[]",
    });

    resetSpies();
    await getZaicoBackgroundSyncStatus();
    check(totalCalls() > 0, "比較対照: fixture OFFでgetZaicoBackgroundSyncStatusはDynamoDB境界へ到達する", JSON.stringify(dataClientMock.__calls));

    resetSpies();
    await startZaicoBackgroundSyncJob("qa@example.com", "DELTA");
    check(totalCalls() > 0, "比較対照: fixture OFFでstartZaicoBackgroundSyncJobはDynamoDB境界へ到達する");

    resetSpies();
    dataClientMock.__setJobRow({
      id: ZAICO_SYNC_JOB_ID,
      status: "PENDING",
      mode: "DELTA",
      lastPage: 0,
      totalProcessed: 0,
      seenSourceIds: "[]",
    });
    await advanceZaicoBackgroundSyncJob("qa@example.com");
    check(totalCalls() > 0, "比較対照: fixture OFFでadvanceZaicoBackgroundSyncJobはDynamoDB/ZAICO API境界へ到達する", JSON.stringify([...dataClientMock.__calls, ...apiMock.__calls]));

    resetSpies();
    dataClientMock.__setJobRow({ id: ZAICO_SYNC_JOB_ID, status: "PENDING", mode: "DELTA" });
    await cancelZaicoBackgroundSyncJob();
    check(totalCalls() > 0, "比較対照: fixture OFFでcancelZaicoBackgroundSyncJobはDynamoDB境界へ到達する");
  }

  console.log("\n── 本題(fixture ON): 4関数がSDK境界へ一度も到達しない ──");
  {
    process.env.INVENTORY_E2E_FIXTURES = "1";
    nextHeadersMock.__setScenarioCookie(undefined); // 未指定 → "delta"シナリオ既定

    resetSpies();
    const job = await getZaicoBackgroundSyncStatus();
    check(totalCalls() === 0, "★要件: fixture ONでgetZaicoBackgroundSyncStatusはDynamoDBへ一切到達しない", JSON.stringify(dataClientMock.__calls));
    check(job?.status === "COMPLETED", "合成ジョブはCOMPLETED(PENDING/RUNNINGを返さない=画面が自動advanceしない)", job?.status);
    check(job?.mode === "DELTA" && job?.syncSince === "2026-09-14T16:00:00.000Z", "delta シナリオ: 差分基準日時(syncSince)が表示できる値で入っている", job?.syncSince ?? "null");
    check(job?.pendingRetryCount === 1, "delta シナリオ: 持ち越し再試行が1件表示される", String(job?.pendingRetryCount));

    resetSpies();
    const startResult = await startZaicoBackgroundSyncJob("qa@example.com", "DELTA");
    check(totalCalls() === 0, "★要件: fixture ONでstartZaicoBackgroundSyncJobはDynamoDBへ一切到達しない");
    check(startResult.started === false, "fixture ONのstartは実際には開始しない(started:false)", JSON.stringify(startResult));

    resetSpies();
    const advanceResult = await advanceZaicoBackgroundSyncJob("qa@example.com");
    check(totalCalls() === 0, "★要件: fixture ONでadvanceZaicoBackgroundSyncJobはDynamoDB/ZAICO APIへ一切到達しない");
    check(advanceResult.shouldContinue === false, "fixture ONのadvanceはshouldContinue:false(ポーリングループを継続させない)");

    resetSpies();
    await cancelZaicoBackgroundSyncJob();
    check(totalCalls() === 0, "★要件: fixture ONでcancelZaicoBackgroundSyncJobはDynamoDBへ一切到達しない");

    console.log("\n── recovery シナリオ(Cookie切替) ──");
    nextHeadersMock.__setScenarioCookie("recovery");
    resetSpies();
    const recoveryJob = await getZaicoBackgroundSyncStatus();
    check(totalCalls() === 0, "★要件: recoveryシナリオでもDynamoDBへ一切到達しない");
    check(recoveryJob?.syncSince === null, "recovery シナリオ: syncSince が null(復旧スキャン=基準を無視して全件)", String(recoveryJob?.syncSince));
    check(
      recoveryJob?.lastSuccessfulSyncAt === "2026-09-13T21:00:03.000Z",
      "recovery シナリオ: lastSuccessfulSyncAtは過去の実在時刻(「一度も成功していない真の初回」ではないことが読み取れる)",
      String(recoveryJob?.lastSuccessfulSyncAt),
    );
    check(recoveryJob?.pendingRetryCount === 0, "recovery シナリオ: 全件再捕捉により持ち越し再試行は解消(0件)");
    check(
      recoveryJob?.syncSince !== job?.syncSince,
      "初回/復旧と毎回(差分あり)の表示を混同しない: deltaシナリオ(syncSince有り)とrecoveryシナリオ(syncSince null)が同じ値を返していない",
    );
  }

  if (originalFixtureFlag === undefined) delete process.env.INVENTORY_E2E_FIXTURES;
  else process.env.INVENTORY_E2E_FIXTURES = originalFixtureFlag;

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
