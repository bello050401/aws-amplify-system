/**
 * lib/inventory/salesAggregateSnapshot.ts / salesAggregateFreshness.ts の
 * 回帰テスト(2026-09-11 世代整合性修正、2026-09-11 task_e509 引継ぎ
 * 完了対応で壊れた配列要素の検証を追加)。
 *
 * 外部依存(DynamoDB SDK等)を一切importしない純粋ロジックのみを検証する
 * ので、node_modulesの有無やAWS認証情報に関わらずどの環境でも実行できる。
 *
 * 実行: node scripts/verify-sales-aggregate-snapshot.ts
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

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
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
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const SAMPLE = [
  { yearMonth: "2026-08", count: 2, totalSales: 30000, totalPurchase: 15000, totalShipping: 0, totalCost: 15000, totalProfit: 15000 },
  { yearMonth: "2026-09", count: 1, totalSales: 10000, totalPurchase: 6000, totalShipping: 0, totalCost: 6000, totalProfit: 4000 },
];

async function main() {
  const snapshotMod = await import("@/lib/inventory/salesAggregateSnapshot");
  const { serializeSnapshotMonths, deserializeSnapshotMonths, monthsToMap, isNewerGeneration } = snapshotMod;
  const freshnessMod = await import("@/lib/inventory/salesAggregateFreshness");
  const {
    describeAggregateFreshness,
    buildSuccessRunStatusFields,
    SALES_AGGREGATE_RUN_TIMEOUT_MINUTES,
    SALES_AGGREGATE_STALE_AFTER_HOURS,
  } = freshnessMod;

  console.log("── serialize/deserialize 往復 ──");
  {
    const json = serializeSnapshotMonths(SAMPLE);
    const back = deserializeSnapshotMonths(json);
    check(JSON.stringify(back) === JSON.stringify(SAMPLE), "往復して完全に一致する");

    let threw = false;
    try { deserializeSnapshotMonths('{"not":"an array"}'); } catch { threw = true; }
    check(threw, "配列でないJSONは例外を投げる(黙って0件=売上0円に見せない)");

    const map = monthsToMap(SAMPLE);
    check(map.get("2026-09")?.totalSales === 10000, "monthsToMapはyearMonthで引ける");
    check(map.get("2026-07") === undefined, "存在しない月はundefined(=missingとして扱われる)");
  }

  console.log("\n── deserializeSnapshotMonths(壊れた配列要素の検証、2026-09-11引継ぎ完了対応) ──");
  {
    let threw = false;
    try { deserializeSnapshotMonths(JSON.stringify([{ yearMonth: "2026-09", count: 1 }])); } catch { threw = true; }
    check(threw, "★要件: 必須の数値フィールドが欠落した要素は例外を投げる(不正値を正常表示しない)");

    threw = false;
    try {
      deserializeSnapshotMonths(
        JSON.stringify([{ yearMonth: "2026-09", count: 1, totalSales: "10000", totalPurchase: 0, totalShipping: 0, totalCost: 0, totalProfit: 0 }]),
      );
    } catch { threw = true; }
    check(threw, "★要件: 数値フィールドが文字列(型不一致)の要素は例外を投げる");

    threw = false;
    try {
      deserializeSnapshotMonths(
        JSON.stringify([{ yearMonth: "2026-09", count: 1, totalSales: Infinity, totalPurchase: 0, totalShipping: 0, totalCost: 0, totalProfit: 0 }]),
      );
    } catch { threw = true; }
    // JSON.stringify(Infinity) は "null" になるため、実際にはnullとして
    // 型チェックに落ちる経路を通る——それでも例外になることを確認する。
    check(threw, "★要件: 非有限の数値(Infinity/NaN相当)を含む要素は例外を投げる");

    threw = false;
    try { deserializeSnapshotMonths(JSON.stringify([{ ...SAMPLE[0], yearMonth: "2026-9" }])); } catch { threw = true; }
    check(threw, "★要件: yearMonthが\"YYYY-MM\"形式でない要素は例外を投げる");

    threw = false;
    try { deserializeSnapshotMonths(JSON.stringify([SAMPLE[0], SAMPLE[0]])); } catch { threw = true; }
    check(threw, "★要件: yearMonthが重複する配列は例外を投げる(どちらが正しいか判定できない)");

    const back = deserializeSnapshotMonths(serializeSnapshotMonths([]));
    check(Array.isArray(back) && back.length === 0, "空配列は正常に往復する(=スナップショットは存在するが全月0件、というありうる正常状態)");
  }

  console.log("\n── isNewerGeneration(楽観的排他制御の判定) ──");
  {
    check(isNewerGeneration(null, "2026-09-11T00:00:00.000Z"), "既存が無い(初回)なら常に公開してよい");
    check(isNewerGeneration("2026-09-11T00:00:00.000Z", "2026-09-11T12:00:00.000Z"), "新しい世代(時刻が後)は公開してよい");
    check(!isNewerGeneration("2026-09-11T12:00:00.000Z", "2026-09-11T00:00:00.000Z"), "★要件: 古い世代は新しいものを上書きしない(同時実行で遅れて完了した古い方が負ける)");
    check(!isNewerGeneration("2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.000Z"), "同一世代は「新しい」とは判定しない(冪等)");
  }

  console.log("\n── describeAggregateFreshness(定期実行の鮮度判定) ──");
  {
    const now = "2026-09-11T12:00:00.000Z";

    check(describeAggregateFreshness(null, now).neverRun, "★要件: 初回未集計(行が無い)はneverRun=true、例外にしない");
    check(describeAggregateFreshness(null, now).isStale, "neverRunは常にisStale扱い(要注意)");

    const running = describeAggregateFreshness(
      { id: "current", state: "RUNNING", startedAt: "2026-09-11T11:58:00.000Z", completedAt: null, lastSuccessAt: "2026-09-11T00:00:00.000Z", publishedGeneration: "2026-09-11T00:00:00.000Z", monthsInSnapshot: 5, sourceRecordCount: 5300, errorMessage: null, durationMs: null },
      now,
    );
    check(running.isRunning && !running.isStalled, `RUNNINGでtimeout(${SALES_AGGREGATE_RUN_TIMEOUT_MINUTES}分)未経過ならisRunning`);

    const stalled = describeAggregateFreshness(
      { id: "current", state: "RUNNING", startedAt: "2026-09-11T11:00:00.000Z", completedAt: null, lastSuccessAt: null, publishedGeneration: null, monthsInSnapshot: null, sourceRecordCount: null, errorMessage: null, durationMs: null },
      now,
    );
    check(stalled.isStalled && !stalled.isRunning, "RUNNINGのままtimeoutを超えるとisStalled(止まった疑い)");

    const failed = describeAggregateFreshness(
      { id: "current", state: "FAILED", startedAt: now, completedAt: now, lastSuccessAt: "2026-09-11T00:00:00.000Z", publishedGeneration: "2026-09-11T00:00:00.000Z", monthsInSnapshot: 5, sourceRecordCount: 5300, errorMessage: "boom", durationMs: 1000 },
      now,
    );
    check(failed.lastAttemptFailed && !failed.isStale, "★要件: 直近が失敗していても、前回成功が新しければ画面の数字自体は古い扱いにしない(失敗を成功扱いにはしないが、直近の確定値は維持)");
    check(failed.errorMessage === "boom", "失敗時のエラーメッセージが伝わる");

    const staleSuccess = describeAggregateFreshness(
      { id: "current", state: "SUCCESS", startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:00.000Z", lastSuccessAt: "2026-09-01T00:00:00.000Z", publishedGeneration: "2026-09-01T00:00:00.000Z", monthsInSnapshot: 5, sourceRecordCount: 5300, errorMessage: null, durationMs: 1000 },
      now,
    );
    check(staleSuccess.isStale, `前回成功から${SALES_AGGREGATE_STALE_AFTER_HOURS}時間超なら定期実行が止まっている疑いとしてisStale`);
  }

  console.log("\n── buildSuccessRunStatusFields(同時実行で負けた側もSUCCESSを書けるか) ──");
  {
    const base = {
      completedAt: "2026-09-11T12:00:00.000Z",
      generation: "2026-09-11T11:58:00.000Z",
      monthsInSnapshot: 5,
      sourceRecordCount: 5300,
      durationMs: 1234,
    };

    const won = buildSuccessRunStatusFields({ ...base, published: true });
    check(won.publishedGeneration === base.generation, "公開できた側はpublishedGenerationに自分の世代が入る");
    check(!Object.values(won).includes(undefined), "公開できた側もundefined値を一切含まない");

    const lost = buildSuccessRunStatusFields({ ...base, published: false });
    check(
      !("publishedGeneration" in lost),
      "★要件: 負けた側はpublishedGenerationキー自体が無い(undefined値として残さない)",
    );
    check(
      !Object.values(lost).includes(undefined),
      "★要件: 負けた側のオブジェクトはundefined値を一切含まない(DynamoDBDocumentClientの" +
        "デフォルトmarshall設定=removeUndefinedValues未指定=falseでも書き込める)",
    );
    check(
      JSON.stringify(lost).includes('"state":"SUCCESS"') && !JSON.stringify(lost).includes("publishedGeneration"),
      "JSON化してもpublishedGenerationは現れない(キー自体が存在しないことの二重確認)",
    );
    check(lost.state === "SUCCESS", "負けた側も自分の計算は成功しているのでstateはSUCCESS(FAILEDにしない)");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
