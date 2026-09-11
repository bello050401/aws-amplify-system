/**
 * loadSalesSummary/loadSalesItems(lib/inventory/salesView.ts)の回帰テスト
 * (2026-09-11 追加修正「開いたとき即表示する」、2026-09-11 世代整合性
 * 修正で salesAggregateStore.ts の内部実装差し替えに合わせシナリオ調整)。
 *
 * ── 何を確かめるか ──────────────────────────────────────────────
 *
 * (旧)修正前は「当月の集計はある」場合でも「対象商品一覧」は常に無条件で
 * listInventoryBySaleMonthを呼んでおり、さらに12ヶ月推移のどこか1ヶ月でも
 * 集計が欠損していれば listAllInventory(在庫全件Scan)まで呼んでいた——
 * 集計が1ヶ月でも欠損しているのは通常運用でも普通に起きる状態のため、
 * 画面を開くだけで実質ほぼ毎回この重い読み取りが起きていた。
 *
 * (新)合計・12ヶ月推移(loadSalesSummary)と明細(loadSalesItems)を完全に
 * 分離した。loadSalesSummaryは**どんな集計状態でもInventoryへ一切
 * アクセスしない**——集計が無い/読めない月は"missing"/"error"という
 * 状態を返すだけで、その場での在庫Scanへは絶対にフォールバックしない。
 * Inventoryへのアクセスが起きるのはloadSalesItemsが呼ばれたとき
 * (=ユーザーが明細を明示的に開いたとき)だけ。
 *
 * 2026-09-11 世代整合性修正での変更点: 集計の読み取りが「月ごとの
 * 複数GetItem」から「単一スナップショットへの1回のGetItem」になった
 * ため、「一部の月だけGetItemが失敗する」というケースはもう実物の
 * salesAggregateStore.tsでは起こり得ない(全部成功するか全部失敗する
 * かのどちらか)。旧シナリオD(当月だけ個別失敗)は削除し、
 * シナリオE(丸ごと失敗)へ統合した。
 *
 * この検証は本物の lib/inventory/salesView.ts / lib/inventory/sales.ts /
 * lib/inventory/salesAggregate.ts を実際に呼び出し、AWS依存の2箇所
 * (lib/inventory/queries.ts, lib/inventory/salesAggregateStore.ts)だけを
 * scripts/__mocks__ 配下のfixtureへ差し替える(server-onlyスタブと同じ
 * 発想 —— salesView.ts からの相対import "./queries" /
 * "./salesAggregateStore" だけをNode 24のregisterHooksでリダイレクトし、
 * 他の呼び出し元のqueries.tsには一切触れない)。実測ログの捏造はしない
 * —— 実関数・実ロジックに、作為的なfixture/例外を注入して検証する。
 *
 * 実行:
 *   node scripts/verify-sales-view-trend-scan.ts
 *   (通常のnode_modulesがある環境では `tsx scripts/verify-sales-view-trend-scan.ts` でも同じ)
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const QUERIES_MOCK_URL = mocksDir + "salesView.queries.mock.cjs";
const AGGREGATE_STORE_MOCK_URL = mocksDir + "salesView.aggregateStore.mock.cjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // "server-only" 自体はここで特別扱いしない —— この検証は必ず
    // with-server-only-stub.cjs 経由で起動され、実物の
    // node_modules/server-only/index.js を一時的にno-opへ書き換え済みな
    // ので、通常解決に任せればよい(data: URLへの差し替えはCJSローダー
    // 経由の読み込みでは解釈されずENOENTになるため使わない)。
    // salesView.ts の中からの相対importだけを差し替える —— 他のどの
    // 呼び出し元から見ても本物のqueries.ts/salesAggregateStore.tsのまま。
    if (context.parentURL?.endsWith("/lib/inventory/salesView.ts")) {
      if (specifier === "./queries") return { url: QUERIES_MOCK_URL, shortCircuit: true };
      if (specifier === "./salesAggregateStore") return { url: AGGREGATE_STORE_MOCK_URL, shortCircuit: true };
    }
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      return nextResolve(target + ".ts", context);
    }
  },
});

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

type Row = {
  id: string;
  displayId: string;
  sku: string;
  name: string;
  saleEndDate: string;
  salePrice: number | null;
  purchasePrice: number | null;
  shippingCost: number | null;
};

function rec(id: string, saleEndDate: string, salePrice: number, purchasePrice: number): Row {
  return { id, displayId: id, sku: id, name: `商品${id}`, saleEndDate, salePrice, purchasePrice, shippingCost: 0 };
}

// 2025-10 〜 2026-09(年またぎを含む12ヶ月)。現在月は2026-09。
const FIXTURE_RECORDS: Row[] = [
  rec("A1", "2025-10-05", 10000, 6000),
  rec("A2", "2025-11-12", 20000, 9000),
  rec("A3", "2025-12-20", 5000, 2000),
  rec("A4", "2026-01-08", 8000, 3000), // 年またぎ
  rec("A5", "2026-02-14", 12000, 7000),
  rec("A6", "2026-06-01", 3000, 1000),
  rec("A7", "2026-09-02", 15000, 5000), // 当月
  rec("A8", "2026-09-20", 25000, 10000), // 当月
];

function buildAggregateRow(yearMonth: string, totalSales: number, totalPurchase: number, count: number) {
  return {
    yearMonth,
    count,
    totalSales,
    totalPurchase,
    totalShipping: 0,
    totalCost: totalPurchase,
    totalProfit: totalSales - totalPurchase,
    sourceRecordCount: count,
    rebuiltAt: "2026-09-09T00:00:00.000Z",
    rebuiltBy: "test",
    generation: "2026-09-09T00:00:00.000Z",
  };
}

const ALL_TREND_MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

async function main() {
  const salesView = await import("@/lib/inventory/salesView");
  const salesLib = await import("@/lib/inventory/sales");
  const queriesMock = await import(QUERIES_MOCK_URL);
  const aggMock = await import(AGGREGATE_STORE_MOCK_URL);

  const expectedLive = (year: number, month: number) => salesLib.summarizeSales(FIXTURE_RECORDS, year, month);

  // ── シナリオA: 当月の集計あり・過去2ヶ月の集計が欠損(missing) ──
  //    要件の核心: 集計が1ヶ月でも欠損していても、summaryはInventoryへ
  //    一切アクセスしない(旧実装はここで在庫全件Scanへフォールバック
  //    していた)。
  console.log("── シナリオA: 当月の集計あり・過去2ヶ月の集計が欠損(missing) ──");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    aggregates.set("2025-10", buildAggregateRow("2025-10", 99999, 1, 1));
    aggregates.set("2025-12", buildAggregateRow("2025-12", 5000, 2000, 1));
    aggregates.set("2026-01", buildAggregateRow("2026-01", 8000, 3000, 1));
    aggregates.set("2026-06", buildAggregateRow("2026-06", 3000, 1000, 1));
    aggregates.set("2026-09", buildAggregateRow("2026-09", 40000, 15000, 2)); // 当月
    // 2025-11 と 2026-02 は意図的に欠損させる(missing、error扱いではない)。

    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    const summary = await salesView.loadSalesSummary(2026, 9);

    check(summary.status === "ok", "当月集計ありならstatus=ok");
    check(summary.totals.totalSales === 40000, "当月合計は集計テーブルの値(40000)", String(summary.totals.totalSales));
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 0,
      "★要件: 過去月に欠損(missing)があってもInventoryへは一切アクセスしない(listInventoryBySaleMonthは0回)",
      JSON.stringify(queriesMock.calls.listInventoryBySaleMonth),
    );

    const trendByMonth = new Map(summary.trend.map((t) => [`${t.year}-${String(t.month).padStart(2, "0")}`, t]));
    check(trendByMonth.get("2025-10")?.status === "ok" && trendByMonth.get("2025-10")?.totalSales === 99999, "集計がある月(2025-10)はok・集計テーブルの値", JSON.stringify(trendByMonth.get("2025-10")));
    check(trendByMonth.get("2025-11")?.status === "missing", "集計が欠損した月(2025-11)はmissing(0円ではなく「値を持たない」)", JSON.stringify(trendByMonth.get("2025-11")));
    check(trendByMonth.get("2026-02")?.status === "missing", "もう一方の欠損月(2026-02)もmissing", JSON.stringify(trendByMonth.get("2026-02")));
    check(summary.trend.length === 12, "推移は12ヶ月ぶん", String(summary.trend.length));
    check(
      summary.trend[0].year === 2025 && summary.trend[0].month === 10 && summary.trend[11].year === 2026 && summary.trend[11].month === 9,
      "月境界(年またぎ)を正しく跨ぐ(先頭2025-10、末尾2026-09)",
      `${summary.trend[0].year}-${summary.trend[0].month} 〜 ${summary.trend[11].year}-${summary.trend[11].month}`,
    );
  }

  // ── シナリオB: 集計が全月そろっている ─────────────────────
  console.log("\n── シナリオB: 集計が全月そろっている ─────────────────────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    for (const ym of ALL_TREND_MONTHS) aggregates.set(ym, buildAggregateRow(ym, 0, 0, 0));
    aggregates.set("2026-09", buildAggregateRow("2026-09", 40000, 15000, 2));
    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    const summary = await salesView.loadSalesSummary(2026, 9);

    check(summary.trend.every((t) => t.status === "ok"), "推移12ヶ月すべてok");
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 0,
      "★要件: 集計が全月そろっていてもInventoryへは一切アクセスしない",
      String(queriesMock.calls.listInventoryBySaleMonth.length),
    );
  }

  // ── シナリオC: 当月の集計が無い(missing) ──────────────────
  //    旧実装はここで在庫全件Scanにより「正しい実数」を出していたが、
  //    新要件はInventoryへ一切アクセスしないことを優先し、"missing"を
  //    明示する(0円と混同させない)。
  console.log("\n── シナリオC: 当月の集計が無い(missing) ───────────────────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    aggregates.set("2025-10", buildAggregateRow("2025-10", 10000, 6000, 1));
    // 2026-09(当月)は欠損させる。
    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    const summary = await salesView.loadSalesSummary(2026, 9);

    check(summary.status === "missing", "当月集計が無ければstatus=missing");
    check(summary.totals.totalSales === 0, "missingのtotalsはプレースホルダ(0)——UI側はstatusを見て「未集計」と表示し、0円実績とは表示しない", String(summary.totals.totalSales));
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 0,
      "★要件: 当月集計が無くてもInventoryへは一切アクセスしない(以前は全件Scanへフォールバックしていた)",
      JSON.stringify(queriesMock.calls.listInventoryBySaleMonth),
    );
  }

  // ── シナリオE: 集計スナップショット自体が丸ごと読めない(error) ──
  //    2026-09-11世代整合性修正: 読み取りが単一アイテムへのGetItem
  //    1回になったため、失敗は必ず「要求した月すべて」に及ぶ
  //    (旧シナリオDの「当月だけ個別失敗」は実物ではもう起こらない)。
  console.log("\n── シナリオE: 集計スナップショットが丸ごと読めない(error) ──");
  {
    aggMock.__failAll("集計テーブル未デプロイ(模擬)");
    queriesMock.__reset(FIXTURE_RECORDS);

    const summary = await salesView.loadSalesSummary(2026, 9);
    check(summary.status === "error", "集計テーブル障害時は画面を落とさずerror扱いにする(例外を投げない)");
    check(summary.trend.every((t) => t.status === "error"), "推移12ヶ月すべてerror(missingと区別される)");
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 0,
      "★要件: 集計テーブル全滅でもInventoryへは一切アクセスしない",
      String(queriesMock.calls.listInventoryBySaleMonth.length),
    );
  }

  // ── シナリオF: loadSalesItems(明細) — ユーザーが明示的に開いたときだけ呼ばれる経路 ──
  console.log("\n── シナリオF: loadSalesItems(明細)は独立して動作する ──────");
  {
    aggMock.__setAggregates(new Map()); // 集計の状態に関わらず明細は取れる
    queriesMock.__reset(FIXTURE_RECORDS);

    const items = await salesView.loadSalesItems(2026, 9);
    const expected = expectedLive(2026, 9).items;

    check(items.length === 2, "当月(2026-09)の対象商品は2件", String(items.length));
    check(JSON.stringify(items) === JSON.stringify(expected), "summarizeSalesと完全に同じ計算結果(単一の中央計算)");
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 1 && queriesMock.calls.listInventoryBySaleMonth[0] === "2026-9",
      "listInventoryBySaleMonthがちょうど1回、対象月で呼ばれる",
      JSON.stringify(queriesMock.calls.listInventoryBySaleMonth),
    );
  }

  // ── シナリオG: loadSalesItemsの取得失敗は握りつぶさず伝播する ──
  console.log("\n── シナリオG: loadSalesItemsの取得失敗は握りつぶさず伝播する ──");
  {
    queriesMock.__reset(FIXTURE_RECORDS);
    queriesMock.__failNext("listInventoryBySaleMonth", "DynamoDBがスロットリングされました(模擬)");

    let threw = false;
    let message = "";
    try {
      await salesView.loadSalesItems(2026, 9);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(threw && message.includes("スロットリング"), "明細取得の失敗は例外としてそのまま伝わる(黙って0件にしない)", message);
  }

  // ── シナリオH: 在庫・集計とも空データでもクラッシュしない ──────
  console.log("\n── シナリオH: 在庫・集計とも空データ ─────────────────────");
  {
    aggMock.__setAggregates(new Map());
    queriesMock.__reset([]);

    const summary = await salesView.loadSalesSummary(2026, 9);
    check(summary.status === "missing", "集計が無ければstatus=missing(空データでも同じ)");
    check(summary.trend.length === 12 && summary.trend.every((t) => t.status === "missing"), "推移12ヶ月すべてmissing(欠落や例外なし)");

    const items = await salesView.loadSalesItems(2026, 9);
    check(items.length === 0, "在庫が空なら対象商品0件(例外にならない)", String(items.length));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
