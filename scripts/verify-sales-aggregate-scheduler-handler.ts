/**
 * amplify/functions/sales-aggregate-scheduler/handler.ts の境界テスト
 * (2026-09-11 task_e509 引継ぎ完了対応、開発指示§7「実handlerをDynamo
 * 境界mockし条件拒否/書込失敗/前回維持を確認」)。
 *
 * "@aws-sdk/client-dynamodb" / "@aws-sdk/lib-dynamodb" だけを
 * scripts/__mocks__/salesAggregateScheduler.dynamo.mock.cjs へ差し替え、
 * handler.ts自体・lib/inventory/salesAggregate.ts(集計計算)・
 * lib/inventory/salesAggregateSnapshot.ts(serializeSnapshotMonths)・
 * lib/inventory/salesAggregateFreshness.ts(buildSuccessRunStatusFields)は
 * すべて実物のまま呼び出す。
 *
 * 実行: node scripts/verify-sales-aggregate-scheduler-handler.ts
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

process.env.INVENTORY_TABLE_NAME = "mock-inventory-table";
process.env.SALES_AGGREGATE_SNAPSHOT_TABLE_NAME = "mock-snapshot-table";
process.env.SALES_AGGREGATE_RUN_STATUS_TABLE_NAME = "mock-run-status-table";

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const DYNAMO_MOCK_URL = mocksDir + "salesAggregateScheduler.dynamo.mock.cjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    const fromHandler = context.parentURL?.endsWith("/functions/sales-aggregate-scheduler/handler.ts");
    if (fromHandler && (specifier === "@aws-sdk/client-dynamodb" || specifier === "@aws-sdk/lib-dynamodb")) {
      return { url: DYNAMO_MOCK_URL, shortCircuit: true };
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

function invItem(id: string, saleEndDate: string, salePrice: number, purchasePrice: number) {
  return { id, sku: id, name: `商品${id}`, saleEndDate, salePrice, purchasePrice, shippingCost: 0, deletedAt: null };
}

async function main() {
  const { handler } = await import("@/amplify/functions/sales-aggregate-scheduler/handler");
  const mock = await import(DYNAMO_MOCK_URL);

  // ── シナリオ1: 正常実行(初回・既存snapshotなし) ────────────
  console.log("── シナリオ1: 正常実行(初回) ──────────────────────────────");
  {
    mock.__configure({ items: [invItem("A1", "2026-09-05", 10000, 6000)] });
    const result = await handler();
    check(result.ok === true && result.published === true, "初回は公開成功", JSON.stringify(result));
    const stored = mock.__getSnapshotStorage();
    check(stored !== undefined && JSON.parse(stored.monthsJson).length === 1, "スナップショットが書き込まれた");
    const lastRunStatus = mock.calls.runStatusPuts.at(-1);
    check(lastRunStatus?.state === "SUCCESS" && lastRunStatus?.publishedGeneration === stored.generation, "RunStatusがSUCCESS・publishedGenerationが一致");
  }

  // ── シナリオ2: 条件拒否(同時実行で自分より新しい世代が既に公開済み) ──
  console.log("\n── シナリオ2: 条件拒否(ConditionalCheckFailedException) ─────");
  {
    const before = { id: "current", generation: "9999-01-01T00:00:00.000Z", monthsJson: "[]", sourceRecordCount: 0, rebuiltAt: "x", rebuiltBy: "x" };
    mock.__configure({ items: [invItem("A1", "2026-09-05", 10000, 6000)], existingSnapshot: before, snapshotPutBehavior: "conditionalFail" });
    const result = await handler();
    check(result.ok === true && result.published === false, "★要件: 条件拒否は失敗として扱わない(published=falseで正常終了)", JSON.stringify(result));
    check(mock.__getSnapshotStorage() === before, "★要件: 条件拒否時は前回のスナップショットがそのまま維持される(1バイトも変わらない)");
    const lastRunStatus = mock.calls.runStatusPuts.at(-1);
    check(lastRunStatus?.state === "SUCCESS", "★要件: 負けた側も自分の計算自体は成功しているのでRunStatusはSUCCESS");
    // buildSuccessRunStatusFieldsはpublishedGenerationキーを省略するが、
    // handler.tsのwriteRunStatusは書き込み前にGetItemで読んだ既存行の
    // publishedGeneration(無ければnull)を先にItemへ入れてから...fieldsを
    // 展開するため、実際に書かれるItemではキー自体は残る(値はnull/既存値)
    // ——ここで検証すべきは「undefined値としてmarshallされない」ことで
    // あって「キーが消える」ことではない(undefinedはJSONにもならないため
    // JSON.stringifyでは判定できず、Object.hasOwnで直接見る)。
    check(
      Object.prototype.hasOwnProperty.call(lastRunStatus, "publishedGeneration") && lastRunStatus.publishedGeneration !== undefined,
      "★要件: 負けた側もpublishedGenerationがundefinedのまま書かれることはない(marshallエラー対策)",
      JSON.stringify(lastRunStatus.publishedGeneration),
    );
    check(lastRunStatus.publishedGeneration === null, "★要件: 負けた側は自分の世代をpublishedGenerationへ書かない(既存値=nullのまま維持)");
  }

  // ── シナリオ3: 書込失敗(PutItemがConditionalCheckFailedException以外の例外) ──
  console.log("\n── シナリオ3: 書込失敗(その他の例外) ────────────────────────");
  {
    const before = { id: "current", generation: "2026-09-01T00:00:00.000Z", monthsJson: JSON.stringify([{ yearMonth: "2026-08", count: 1, totalSales: 1000, totalPurchase: 500, totalShipping: 0, totalCost: 500, totalProfit: 500 }]), sourceRecordCount: 1, rebuiltAt: "2026-09-01T00:00:00.000Z", rebuiltBy: "x" };
    mock.__configure({ items: [invItem("A1", "2026-09-05", 10000, 6000)], existingSnapshot: before, snapshotPutBehavior: "otherFail" });

    let threw = false;
    let message = "";
    try {
      await handler();
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(threw, "★要件: 書込失敗はhandler自体が例外を投げる(Lambdaの失敗として記録される)", message);
    check(mock.__getSnapshotStorage() === before, "★要件: 書込失敗時も前回のスナップショットがそのまま維持される(欠落も二重計上も起きない)");
    const lastRunStatus = mock.calls.runStatusPuts.at(-1);
    check(lastRunStatus?.state === "FAILED", "★要件: 書込失敗はRunStatusにFAILEDとして記録される(成功扱いにしない)");
    check(typeof lastRunStatus?.errorMessage === "string" && lastRunStatus.errorMessage.length > 0, "失敗理由がerrorMessageに記録される", lastRunStatus?.errorMessage);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
