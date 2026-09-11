/**
 * lib/inventory/salesAggregateStore.ts の境界テスト(2026-09-11 task_e509
 * 引継ぎ完了対応、開発指示§7「実storeを外部dataClient境界mockして
 * GraphQL errors、snapshotなし、snapshot空、指定月なし、不正配列要素/
 * 数値、正常値を検証」)。
 *
 * scripts/verify-sales-view-trend-scan.ts は salesAggregateStore.ts
 * 自体をモックへ差し替えて salesView.ts を検証するテストで、
 * salesAggregateStore.ts 自身のロジック(fetchSnapshotのerrors処理、
 * 「実0件」と「未集計」の区別、壊れたmonthsJsonの検証)は通らない
 * ——このスクリプトは salesAggregateStore.ts を実物のまま呼び出し、
 * その1つ下の境界(lib/amplify/dataClient.ts の serverDataClient)だけを
 * モックへ差し替える。deserializeSnapshotMonths(salesAggregateSnapshot.ts)
 * も実物のまま通す——「壊れたJSONの配列要素を検証する」ロジック自体が
 * 実際にstore経由で効くことを確認する。
 *
 * 実行: node scripts/verify-sales-aggregate-store-boundary.ts
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
const DATA_CLIENT_MOCK_URL = mocksDir + "salesAggregateStore.dataClient.mock.cjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // "server-only" 自体はここで特別扱いしない —— この検証は必ず
    // with-server-only-stub.cjs 経由で起動され、実物の
    // node_modules/server-only/index.js を一時的にno-opへ書き換え済みな
    // ので、通常解決に任せればよい(data: URLへの差し替えはCJSローダー
    // 経由の読み込みでは解釈されずENOENTになるため使わない)。
    // salesAggregateStore.ts の中からの "@/lib/amplify/dataClient" importだけを
    // 差し替える——他のどの呼び出し元から見ても本物のdataClient.tsのまま。
    if (context.parentURL?.endsWith("/lib/inventory/salesAggregateStore.ts") && specifier === "@/lib/amplify/dataClient") {
      return { url: DATA_CLIENT_MOCK_URL, shortCircuit: true };
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

function row(yearMonth: string, totalSales: number, totalPurchase: number, count: number) {
  return { yearMonth, count, totalSales, totalPurchase, totalShipping: 0, totalCost: totalPurchase, totalProfit: totalSales - totalPurchase };
}

function snapshotItem(months: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: "current",
    generation: "2026-09-11T00:00:00.000Z",
    monthsJson: JSON.stringify(months),
    sourceRecordCount: 5300,
    rebuiltAt: "2026-09-11T00:00:00.000Z",
    rebuiltBy: "sales-aggregate-scheduler",
    ...overrides,
  };
}

async function main() {
  const store = await import("@/lib/inventory/salesAggregateStore");
  const mock = await import(DATA_CLIENT_MOCK_URL);

  // ── シナリオ1: GraphQL errors(dataなし・errorsあり) ──────────
  console.log("── シナリオ1: GraphQL errors ──────────────────────────────");
  {
    mock.__setGetResult({ data: null, errors: [{ message: "Not Authorized" }] });
    const { aggregates, failedMonths } = await store.getMonthlyAggregates(["2026-08", "2026-09"]);
    check(aggregates.size === 0, "★要件: GraphQL errorsがあればaggregatesは空");
    check(
      failedMonths.length === 2 && failedMonths.includes("2026-08") && failedMonths.includes("2026-09"),
      "★要件: 取得errorsはerrorへ——要求した月すべてがfailedMonths(neverRunと混同しない)",
      JSON.stringify(failedMonths),
    );
  }

  // ── シナリオ2: snapshotなし(data null・errorsもなし) ──────────
  console.log("\n── シナリオ2: snapshotなし(neverRun) ──────────────────────");
  {
    mock.__setGetResult({ data: null, errors: undefined });
    const { aggregates, failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    check(aggregates.size === 0, "★要件: snapshotなしはaggregates空");
    check(failedMonths.length === 0, "★要件: snapshotなしはfailedMonths空(errorではなくmissing=未集計)");
  }

  // ── シナリオ3: snapshot空(monthsJson = "[]") ─────────────────
  console.log("\n── シナリオ3: snapshot空(確定0件) ──────────────────────────");
  {
    mock.__setGetResult({ data: snapshotItem([]), errors: undefined });
    const { aggregates, failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    check(failedMonths.length === 0, "空snapshotはerrorではない");
    const agg = aggregates.get("2026-09");
    check(
      agg !== undefined && agg.totalSales === 0 && agg.count === 0,
      "★要件: 確定snapshotありで指定月なしなら売上0(missingではなくok・0円)",
      JSON.stringify(agg),
    );
    check(agg?.rebuiltAt === "2026-09-11T00:00:00.000Z" && agg?.generation === "2026-09-11T00:00:00.000Z", "0埋め行にもsnapshotのrebuiltAt/generationが付く");
  }

  // ── シナリオ4: snapshotあり・指定月だけ無い(他の月はある) ──────
  console.log("\n── シナリオ4: snapshotあり・指定月なし(他の月はある) ─────────");
  {
    mock.__setGetResult({ data: snapshotItem([row("2026-08", 30000, 15000, 2)]), errors: undefined });
    const { aggregates } = await store.getMonthlyAggregates(["2026-08", "2026-09"]);
    check(aggregates.get("2026-08")?.totalSales === 30000, "存在する月(2026-08)は実データ");
    check(aggregates.get("2026-09")?.totalSales === 0 && aggregates.get("2026-09")?.count === 0, "★要件: snapshotはあるが指定月(2026-09)だけ無い→実0件(missingにしない)");
  }

  // ── シナリオ5: 不正配列要素(必須項目欠落) ──────────────────
  console.log("\n── シナリオ5: 不正配列要素(必須項目欠落) ─────────────────");
  {
    mock.__setGetResult({ data: snapshotItem([{ yearMonth: "2026-09", count: 1 }]), errors: undefined });
    const { aggregates, failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    check(aggregates.size === 0, "★要件: 不正な行が混ざったsnapshotはaggregatesへ何も出さない(不正値を正常表示しない)");
    check(failedMonths.length === 1 && failedMonths[0] === "2026-09", "★要件: 不正な配列要素はerror扱い(黙って0件にしない)", JSON.stringify(failedMonths));
  }

  // ── シナリオ6: 不正配列要素(非有限の数値) ───────────────────
  console.log("\n── シナリオ6: 不正配列要素(非有限の数値) ────────────────────");
  {
    mock.__setGetResult({
      data: snapshotItem([{ yearMonth: "2026-09", count: 1, totalSales: "10000", totalPurchase: 0, totalShipping: 0, totalCost: 0, totalProfit: 0 }]),
      errors: undefined,
    });
    const { failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    check(failedMonths.length === 1, "★要件: 数値であるべきフィールドが文字列の行はerror扱い");
  }

  // ── シナリオ7: 不正配列要素(yearMonth重複) ───────────────────
  console.log("\n── シナリオ7: 不正配列要素(yearMonth重複) ────────────────────");
  {
    mock.__setGetResult({ data: snapshotItem([row("2026-09", 1000, 500, 1), row("2026-09", 2000, 1000, 1)]), errors: undefined });
    const { failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    check(failedMonths.length === 1, "★要件: yearMonthが重複した配列はerror扱い(どちらが正しいか判定できない)");
  }

  // ── シナリオ8: 正常値 ─────────────────────────────────────
  console.log("\n── シナリオ8: 正常値 ─────────────────────────────────────");
  {
    mock.__setGetResult({ data: snapshotItem([row("2026-09", 40000, 15000, 2)], { sourceRecordCount: 5313 }), errors: undefined });
    const { aggregates, failedMonths } = await store.getMonthlyAggregates(["2026-09"]);
    const agg = aggregates.get("2026-09");
    check(failedMonths.length === 0, "正常値はerrorにならない");
    check(agg?.totalSales === 40000 && agg?.totalProfit === 25000, "正常値: 集計値が正しく届く", JSON.stringify(agg));
    check(agg?.sourceRecordCount === 5313, "正常値: sourceRecordCountも届く");

    // getMonthlyAggregate(単数形)も同じGetItem 1回を経由する。
    const single = await store.getMonthlyAggregate("2026-09");
    check(single?.totalSales === 40000, "getMonthlyAggregate(単数形)も同じ値を返す");

    // listAllMonthlyAggregates はsnapshotの全月をそのまま返す。
    const all = await store.listAllMonthlyAggregates();
    check(all.length === 1 && all[0].yearMonth === "2026-09", "listAllMonthlyAggregatesはsnapshotの全月を返す");
  }

  // ── シナリオ9: 複数回のGetItemを発行しない(1回のfetchSnapshotで複数月をさばく) ──
  console.log("\n── シナリオ9: GetItemは常に1回 ─────────────────────────────");
  {
    mock.__setGetResult({ data: snapshotItem([row("2026-09", 1000, 500, 1)]), errors: undefined });
    await store.getMonthlyAggregates(["2026-01", "2026-02", "2026-09"]);
    check(mock.calls.get.length === 1, "★要件: 3ヶ月要求してもGetItemは1回のみ(スナップショットが単一アイテムのため)", String(mock.calls.get.length));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
