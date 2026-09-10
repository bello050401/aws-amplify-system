/**
 * loadSalesView(lib/inventory/salesView.ts)の回帰テスト(2026-09-10 速度改善)。
 *
 * ── 何を確かめるか ──────────────────────────────────────────────
 *
 * 修正前は「当月の集計はある」が「12ヶ月推移のうち過去の何ヶ月かは集計が
 * 欠損している」場合、欠損月**ごと**に listInventoryBySaleMonth(=在庫の
 * 全件Scan)を個別に呼んでいた —— 欠損月が2つあれば全件Scanが2回、5つ
 * あれば5回、それぞれ並列に走る。売上画面を開くたびに起きるうえ、ZAICO
 * 同期でDynamoDBへの書き込みが重なる時間帯には往復回数が余分に増える
 * ぶんスロットリングに当たりやすくなる**はず**だが、これは実装から導ける
 * 推論であって、参照番号つきエラー画面との因果関係を実測で確認したもの
 * ではない(スロットリング発生の実測ログは無い)。この検証が確認できるのは
 * 「欠損月ごとの個別Scanが1回にまとまったこと」という往復回数の性質のみ。
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

// 2026-09-10 型エラー補正: registerHooksはNode 22.15/23で追加された
// node:module のAPIで、実行環境(Node 24)には実在するが、本プロジェクトの
// @types/node(^20.14.0、依存全体は更新しない方針)にはまだ型定義が無く
// TS2305になる。ここは@types/nodeの更新やts-ignoreではなく、このスクリプト
// が実際に使う形だけを最小限アンビエント宣言する(テスト専用の型補完)。
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
const QUERIES_MOCK_URL = mocksDir + "salesView.queries.mock.mjs";
const AGGREGATE_STORE_MOCK_URL = mocksDir + "salesView.aggregateStore.mock.mjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
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
  rec("A2", "2025-11-12", 20000, 9000), // 集計欠損にする月(シナリオA)
  rec("A3", "2025-12-20", 5000, 2000),
  rec("A4", "2026-01-08", 8000, 3000), // 年またぎ
  rec("A5", "2026-02-14", 12000, 7000), // 集計欠損にする月(シナリオA)
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
  };
}

async function main() {
  const salesView = await import("@/lib/inventory/salesView");
  const salesLib = await import("@/lib/inventory/sales");
  const queriesMock = await import(QUERIES_MOCK_URL);
  const aggMock = await import(AGGREGATE_STORE_MOCK_URL);

  const expectedLive = (year: number, month: number) => salesLib.summarizeSales(FIXTURE_RECORDS, year, month);

  // ── シナリオA: 当月の集計はある。過去の推移12ヶ月のうち2ヶ月
  //    (2025-11, 2026-02)だけ集計が欠損 —— 修正前はこの2ヶ月ぶん
  //    listInventoryBySaleMonth(全件Scan)が個別に走っていた。
  console.log("── シナリオA: 当月の集計あり・過去2ヶ月の集計が欠損 ──────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    // 2025-10 は「集計にある値」を実際のlive計算とわざと違う値にして、
    // 推移がScanの再計算ではなく本当に集計テーブル由来であることを見分ける。
    aggregates.set("2025-10", buildAggregateRow("2025-10", 99999, 1, 1));
    aggregates.set("2025-12", buildAggregateRow("2025-12", 5000, 2000, 1));
    aggregates.set("2026-01", buildAggregateRow("2026-01", 8000, 3000, 1));
    aggregates.set("2026-06", buildAggregateRow("2026-06", 3000, 1000, 1));
    aggregates.set("2026-09", buildAggregateRow("2026-09", 40000, 15000, 2)); // 当月
    // 2025-11 と 2026-02 は意図的に欠損させる。

    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    const view = await salesView.loadSalesView(2026, 9);

    check(view.servedFromAggregate === true, "当月集計ありならservedFromAggregate=true");
    check(view.summary.totalSales === 40000, "当月合計は集計テーブルの値(40000)", String(view.summary.totalSales));
    check(view.summary.items.length === 2, "当月の商品一覧は在庫からの実数(2件)", String(view.summary.items.length));

    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 1 &&
        queriesMock.calls.listInventoryBySaleMonth[0] === "2026-9",
      "listInventoryBySaleMonthは当月ぶん1回だけ(欠損月ごとには呼ばない)",
      JSON.stringify(queriesMock.calls.listInventoryBySaleMonth),
    );
    check(
      queriesMock.calls.listAllInventory === 1,
      "欠損月が2つあっても全件Scan(listAllInventory)は1回だけ",
      String(queriesMock.calls.listAllInventory),
    );

    // 2026-09-10 型エラー補正: 元の実装はここで`t`を{year, month}だけの
    // 型に絞っており、以後totalSales/totalGrossProfitへアクセスすると
    // TS2339になっていた。`t`自体には注釈を付けずview.trendの実際の要素
    // 型(MonthlyTrendPoint)をそのまま推論させ、Mapの値型だけをこの先で
    // 実際に使うフィールドで明示する。
    const trendByMonth = new Map<string, { year: number; month: number; totalSales: number; totalGrossProfit: number }>(
      view.trend.map((t) => [`${t.year}-${t.month}`, t]),
    );
    check(
      trendByMonth.get("2025-10")?.totalSales === 99999,
      "集計がある月(2025-10)は集計テーブルの値を使う(live再計算ではない)",
      String(trendByMonth.get("2025-10")?.totalSales),
    );
    const liveNov = expectedLive(2025, 11);
    check(
      trendByMonth.get("2025-11")?.totalSales === liveNov.totalSales &&
        trendByMonth.get("2025-11")?.totalGrossProfit === liveNov.totalProfit,
      "集計が欠損した月(2025-11)もlistAllInventoryの結果から正しい実数を埋める",
      `sales=${trendByMonth.get("2025-11")?.totalSales} profit=${trendByMonth.get("2025-11")?.totalGrossProfit}`,
    );
    const liveFeb = expectedLive(2026, 2);
    check(
      trendByMonth.get("2026-2")?.totalSales === liveFeb.totalSales &&
        trendByMonth.get("2026-2")?.totalGrossProfit === liveFeb.totalProfit,
      "集計が欠損したもう一方の月(2026-02)も正しい実数",
      `sales=${trendByMonth.get("2026-2")?.totalSales} profit=${trendByMonth.get("2026-2")?.totalGrossProfit}`,
    );
    check(view.trend.length === 12, "推移は12ヶ月ぶん", String(view.trend.length));
    check(
      view.trend[0].year === 2025 && view.trend[0].month === 10 && view.trend[11].year === 2026 && view.trend[11].month === 9,
      "月境界(年またぎ)を正しく跨ぐ(先頭2025-10、末尾2026-09)",
      `${view.trend[0].year}-${view.trend[0].month} 〜 ${view.trend[11].year}-${view.trend[11].month}`,
    );
  }

  // ── シナリオB: 当月の集計があり、過去の推移も全月そろっている ──
  //    欠損が無いので全件Scanは1回も走ってはいけない。
  console.log("\n── シナリオB: 集計が全月そろっている ─────────────────────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    for (const ym of ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]) {
      aggregates.set(ym, buildAggregateRow(ym, 0, 0, 0));
    }
    aggregates.set("2026-09", buildAggregateRow("2026-09", 40000, 15000, 2));
    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    await salesView.loadSalesView(2026, 9);

    check(
      queriesMock.calls.listAllInventory === 0,
      "推移12ヶ月すべて集計がそろっていれば全件Scanは0回",
      String(queriesMock.calls.listAllInventory),
    );
    check(
      queriesMock.calls.listInventoryBySaleMonth.length === 1,
      "それでも当月の商品一覧ぶんの取得は1回必要(これは意図通り)",
      String(queriesMock.calls.listInventoryBySaleMonth.length),
    );
  }

  // ── シナリオC: 当月の集計が無い(既存分岐、2abfc95で先に修正済み)。
  //    ここが今回のリファクタで壊れていないことを回帰確認する。
  console.log("\n── シナリオC: 当月の集計が無い(既修正分岐の回帰確認) ─────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    aggregates.set("2025-10", buildAggregateRow("2025-10", 10000, 6000, 1));
    // 2026-09(当月)は欠損させる。他にも2025-11を欠損させ、複数欠損でも
    // Scanが1回にまとまることを確認する。
    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);

    const view = await salesView.loadSalesView(2026, 9);

    check(view.servedFromAggregate === false, "当月集計が無ければservedFromAggregate=false");
    check(view.summary.totalSales === 40000, "当月合計はlistInventoryBySaleMonthからの実数(40000)", String(view.summary.totalSales));
    check(
      queriesMock.calls.listAllInventory === 1,
      "当月集計が無い分岐でも、欠損月ぶんの全件Scanはまとめて1回(既存修正の回帰なし)",
      String(queriesMock.calls.listAllInventory),
    );
  }

  // ── シナリオD: 明細取得(listInventoryBySaleMonth)が失敗した場合は
  //    例外がそのまま呼び出し元へ伝播する(既存の設計を維持しているか)。
  console.log("\n── シナリオD: 明細取得の失敗は握りつぶさず伝播する ───────");
  {
    const aggregates = new Map<string, ReturnType<typeof buildAggregateRow>>();
    aggregates.set("2026-09", buildAggregateRow("2026-09", 40000, 15000, 2));
    aggMock.__setAggregates(aggregates);
    queriesMock.__reset(FIXTURE_RECORDS);
    queriesMock.__failNext("listInventoryBySaleMonth", "DynamoDBがスロットリングされました(模擬)");

    let threw = false;
    let message = "";
    try {
      await salesView.loadSalesView(2026, 9);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(threw && message.includes("スロットリング"), "在庫Scanの失敗は例外としてそのまま伝わる(黙って0にしない)", message);
  }

  // ── シナリオE: 集計テーブル自体が読めない(GetItem失敗)場合は、
  //    salesView.ts側の.catch()により画面は落とさずその場で計算する。
  console.log("\n── シナリオE: 集計テーブルが読めなくても画面は落ちない ───");
  {
    aggMock.__failAll("集計テーブル未デプロイ(模擬)");
    queriesMock.__reset(FIXTURE_RECORDS);

    const view = await salesView.loadSalesView(2026, 9);
    check(view.servedFromAggregate === false, "集計テーブル障害時はその場計算に落ちる(例外を投げない)");
    check(view.summary.totalSales === 40000, "その場計算でも当月合計は正しい(40000)", String(view.summary.totalSales));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
