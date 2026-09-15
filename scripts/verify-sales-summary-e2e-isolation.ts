/**
 * 売上予測候補b2b385f(異常日時と表示整合)QA: 実ブラウザ・実売上画面で
 * 安全に確認するために追加したfixture境界(lib/inventory/
 * salesE2eFixtures.ts)の実境界試験。
 *
 * ── 何を証明するか ──────────────────────────────────────────────
 *
 * lib/inventory/salesView.tsのloadSalesSummaryは、通常時
 * SalesAggregateSnapshotへ実GetItem(serverDataClient経由)する。
 * 今回追加したfixtureゲート(isE2EFixtureModeActive())が、この関数から
 * 実SDK境界へ一切到達しないことを、scripts/verify-zaico-sync-e2e-
 * isolation.tsと同じ「OFFでまず到達を確認→ONで0到達を確認」の対照設計
 * で実証する。
 *
 * ── 技法 ────────────────────────────────────────────────────────
 *
 * scripts/verify-zaico-sync-e2e-isolation.tsと同じ理由・同じ技法
 * (tsxのCJS Module._resolveFilename経由の依存解決に対し、
 * createRequireで得たrequireのrequire.cacheへ直接mockを差し込む)を使う。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-sales-summary-e2e-isolation.ts
 */
import { createRequire } from "node:module";

const cjsRequire = createRequire(import.meta.url);

function installMocks() {
  const dataClientMock = cjsRequire("./__mocks__/salesSummaryE2EIsolation.dataClient.mock.cjs") as {
    __resetCalls: () => void;
    __setSnapshotRow: (row: Record<string, unknown> | null) => void;
    __calls: unknown[];
  };
  const nextHeadersMock = cjsRequire("./__mocks__/salesSummaryE2EIsolation.nextHeaders.mock.cjs") as {
    __setScenarioCookie: (value: string | undefined) => void;
  };

  const inject = (specifier: string, exportsValue: unknown) => {
    const resolved = cjsRequire.resolve(specifier);
    cjsRequire.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue } as unknown as NodeJS.Module;
  };
  inject("@/lib/amplify/dataClient", dataClientMock);
  inject("next/headers", nextHeadersMock);

  return { dataClientMock, nextHeadersMock };
}

const { dataClientMock, nextHeadersMock } = installMocks();

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
}
function totalCalls(): number {
  return dataClientMock.__calls.length;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=productionでは isE2EFixtureModeActive() が常にfalseになり、このテスト自体が意味を持たない");
  }

  const { loadSalesSummary } = await import("@/lib/inventory/salesView");

  const originalFixtureFlag = process.env.INVENTORY_E2E_FIXTURES;

  console.log("── 比較対照(fixture OFF): loadSalesSummaryが実際にSDK境界へ到達することをまず確認 ──");
  {
    delete process.env.INVENTORY_E2E_FIXTURES;
    dataClientMock.__setSnapshotRow({
      id: "current",
      generation: "2026-09-14T21:00:00.000Z",
      rebuiltAt: "2026-09-14T21:00:00.000Z",
      rebuiltBy: null,
      sourceRecordCount: 5000,
      monthsJson: "[]",
    });

    resetSpies();
    await loadSalesSummary(2026, 9);
    check(totalCalls() > 0, "比較対照: fixture OFFでloadSalesSummaryはSalesAggregateSnapshot境界へ到達する", JSON.stringify(dataClientMock.__calls));
  }

  console.log("\n── 本題(fixture ON): loadSalesSummaryはSDK境界へ一度も到達しない ──");
  {
    process.env.INVENTORY_E2E_FIXTURES = "1";
    nextHeadersMock.__setScenarioCookie(undefined); // 未指定 → "normal"シナリオ既定

    // 現在のJST年月をこの検証スクリプト自身でも算出し、fixtureの
    // 「現在月だけシナリオが効く」設計と同じ基準で検証する。
    const nowParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric" }).formatToParts(new Date());
    const curYear = Number(nowParts.find((p) => p.type === "year")?.value ?? 0);
    const curMonth = Number(nowParts.find((p) => p.type === "month")?.value ?? 0);

    resetSpies();
    const normalView = await loadSalesSummary(curYear, curMonth);
    check(totalCalls() === 0, "★要件: fixture ONでloadSalesSummaryはSalesAggregateSnapshotへ一切到達しない(正常シナリオ)", JSON.stringify(dataClientMock.__calls));
    check(normalView.status === "ok", "正常シナリオ: status=ok(集計は取れている体)", normalView.status);
    check(normalView.totals.totalSales === 2_407_020, "正常シナリオ: 売上高本体は合成値(2,407,020円)で表示される", String(normalView.totals.totalSales));
    check(typeof normalView.aggregateRebuiltAt === "string" && normalView.aggregateRebuiltAt.length > 0, "正常シナリオ: aggregateRebuiltAtが入っている(前日snapshot相当)", String(normalView.aggregateRebuiltAt));

    resetSpies();
    nextHeadersMock.__setScenarioCookie("invalid");
    const invalidView = await loadSalesSummary(curYear, curMonth);
    check(totalCalls() === 0, "★要件: fixture ONでloadSalesSummaryはSalesAggregateSnapshotへ一切到達しない(不正シナリオ)");
    check(invalidView.status === "ok" && invalidView.totals.totalSales === 2_407_020, "不正シナリオ: 予測の根拠(rebuiltAt)が壊れていても売上本体は維持される", String(invalidView.totals.totalSales));
    check(Number.isNaN(new Date(invalidView.aggregateRebuiltAt ?? "").getTime()), "不正シナリオ: aggregateRebuiltAtはDateとして解析できない値", String(invalidView.aggregateRebuiltAt));

    resetSpies();
    nextHeadersMock.__setScenarioCookie("future");
    const futureView = await loadSalesSummary(curYear, curMonth);
    check(totalCalls() === 0, "★要件: fixture ONでloadSalesSummaryはSalesAggregateSnapshotへ一切到達しない(未来シナリオ)");
    check(futureView.status === "ok" && futureView.totals.totalSales === 2_407_020, "未来シナリオ: 予測の根拠(rebuiltAt)が未来でも売上本体は維持される", String(futureView.totals.totalSales));
    check(new Date(futureView.aggregateRebuiltAt ?? "").getTime() > Date.now(), "未来シナリオ: aggregateRebuiltAtが閲覧時刻より未来", String(futureView.aggregateRebuiltAt));

    console.log("\n── 過去月(シナリオCookieに関係なく常に正常表示) ──");
    nextHeadersMock.__setScenarioCookie("future"); // 現在月なら異常表示になるはずのシナリオを立てたまま
    resetSpies();
    const pastMonth = curMonth === 1 ? 12 : curMonth - 1;
    const pastYear = curMonth === 1 ? curYear - 1 : curYear;
    const pastView = await loadSalesSummary(pastYear, pastMonth);
    check(totalCalls() === 0, "★要件: 過去月でもfixture ONならSalesAggregateSnapshotへ一切到達しない");
    check(pastView.status === "ok", "過去月: status=okで売上本体が表示される", pastView.status);
    check(
      new Date(pastView.aggregateRebuiltAt ?? "").getTime() <= Date.now(),
      "過去月: シナリオCookie(future)に関係なく、常に閲覧時刻以前の妥当なaggregateRebuiltAtを返す(現在月以外はシナリオの対象外)",
      String(pastView.aggregateRebuiltAt),
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
