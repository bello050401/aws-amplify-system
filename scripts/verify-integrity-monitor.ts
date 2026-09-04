/**
 * 整合性監査の差分判定（2026-09-04 最終フェーズ §21）。
 *
 *   npm run verify:integrity-monitor
 *
 * AWSにつながない。判定そのものだけを固定する。
 *
 * 指示書が挙げている検証条件をそのまま項目にしてある:
 *   基準値と同じ / +1 / -1 / 初回実行 / 基準値なし /
 *   実行途中エラー / DynamoDB・AppSync取得エラー
 *
 * とくに最後の2つが重要。走査に失敗した項目を0として記録してしまうと、
 * **次回の基準が壊れる**（本当は315件あるのに0が基準になり、翌日315件に
 * 戻ったのを「+315件の異常」と誤検知する）。取得の失敗と0件は別物。
 */
import { compareIntegrity, formatRunResult, toHistoryEntry, type IntegrityBaseline, type IntegrityMetric } from "@/lib/integrity/compare";
import { collectIntegrityMetrics } from "@/lib/integrity/collect";
import { INTEGRITY_MONITORED_MODELS, INTEGRITY_TABLE_ENV } from "@/lib/integrity/tables";

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const RUN_AT = "2026-09-05T00:00:00.000Z";
const metric = (key: string, value: number | null, error?: string): IntegrityMetric => ({
  key,
  label: key === "orphanHistory" ? "在庫履歴の孤児" : key,
  value,
  ...(error ? { error } : {}),
});
const baselineOf = (values: Record<string, number>): IntegrityBaseline => ({ updatedAt: "2026-09-04T00:00:00.000Z", values });

function testSameAsBaseline() {
  const r = compareIntegrity([metric("orphanHistory", 315)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  check(r.comparisons[0].verdict === "PASS", "基準値と同じ → PASS（315件あること自体を毎回異常にしない）");
  check(r.overall === "PASS", "全体もPASS");
  check(r.shouldNotify === false, "正常時は通知しない");
  check(r.nextBaseline.values.orphanHistory === 315, "基準値は据え置き");
}

function testIncreased() {
  const r = compareIntegrity([metric("orphanHistory", 316)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  check(r.comparisons[0].verdict === "FAIL", "+1 → FAIL（新しい孤児が増えた）");
  check(r.comparisons[0].delta === 1, "差分が+1として出る");
  check(r.overall === "FAIL", "全体もFAIL");
  check(r.shouldNotify === true, "新しい異常は通知する");
  check(
    (r.notificationText ?? "").includes("315 → 316"),
    "通知文に前回値と現在値が入る",
    (r.notificationText ?? "").split("\n")[1] ?? "",
  );
  check(r.nextBaseline.values.orphanHistory === 316, "基準値は現在値へ更新される（同じ異常を毎日通知し続けない）");
}

function testDecreased() {
  const r = compareIntegrity([metric("orphanHistory", 314)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  check(r.comparisons[0].verdict === "WARNING", "-1 → WARNING（修復かもしれないが黙って下げない）");
  check(r.comparisons[0].delta === -1, "差分が-1として出る");
  check(r.shouldNotify === false, "減少は通知しない（記録には残る）");
  check(r.nextBaseline.values.orphanHistory === 314, "基準値は現在値へ更新される");
}

function testFirstRun() {
  const r = compareIntegrity([metric("orphanHistory", 315), metric("dupNotification", 0)], null, RUN_AT);
  check(r.comparisons.every((c) => c.verdict === "NEW"), "初回実行 → すべてNEW（異常にしない）");
  check(r.overall === "NEW", "全体もNEW");
  check(r.shouldNotify === false, "初回は通知しない");
  check(r.nextBaseline.values.orphanHistory === 315 && r.nextBaseline.values.dupNotification === 0, "初回の値が基準値になる");
}

function testMissingBaselineKey() {
  // 基準値ファイルはあるが、その項目だけ無い（検査項目を新しく足した場合）。
  const r = compareIntegrity([metric("orphanHistory", 315), metric("newCheck", 7)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  check(r.comparisons[0].verdict === "PASS", "既存項目は通常どおり判定される");
  check(r.comparisons[1].verdict === "NEW", "新しく足した項目はNEW（いきなり異常にしない）");
  check(r.overall === "PASS", "全体は既存項目の判定に従う");
}

function testScanErrorDoesNotPoisonBaseline() {
  const r = compareIntegrity(
    [metric("orphanHistory", null, "ProvisionedThroughputExceededException"), metric("dupNotification", 0)],
    baselineOf({ orphanHistory: 315, dupNotification: 0 }),
    RUN_AT,
  );
  check(r.comparisons[0].verdict === "ERROR", "取得エラー → ERROR（0件と取り違えない）");
  check(
    r.nextBaseline.values.orphanHistory === 315,
    "**取得できなかった項目の基準値は前回値のまま**（0で上書きしない）",
    `orphanHistory=${r.nextBaseline.values.orphanHistory}`,
  );
  check(r.overall === "ERROR", "全体はERROR");
  check(r.shouldNotify === true, "検査できなかったことも通知する（黙っていると異常なしと区別が付かない）");
  check((r.notificationText ?? "").includes("完了しませんでした"), "通知文が「検査できていない」と分かる文言になる");
}

function testErrorOnFirstRunDoesNotCreateBaseline() {
  const r = compareIntegrity([metric("orphanHistory", null, "AccessDeniedException")], null, RUN_AT);
  check(r.comparisons[0].verdict === "ERROR", "初回かつ取得エラー → ERROR");
  check(
    !("orphanHistory" in r.nextBaseline.values),
    "基準値を作らない（次回また初回として扱う）",
    JSON.stringify(r.nextBaseline.values),
  );
}

function testFailWinsOverWarning() {
  const r = compareIntegrity(
    [metric("orphanHistory", 314), metric("dupNotification", 1)],
    baselineOf({ orphanHistory: 315, dupNotification: 0 }),
    RUN_AT,
  );
  check(r.overall === "FAIL", "1つでも増えていれば全体はFAIL（減少に埋もれさせない）");
  check(r.shouldNotify === true, "通知する");
}

function testRetiredMetricKeepsBaseline() {
  // 今回だけ検査項目を外した場合でも、基準値を消さない。
  const r = compareIntegrity([metric("dupNotification", 0)], baselineOf({ orphanHistory: 315, dupNotification: 0 }), RUN_AT);
  check(r.nextBaseline.values.orphanHistory === 315, "今回測らなかった項目の基準値も残す");
}

function testHistoryEntry() {
  const r = compareIntegrity([metric("orphanHistory", 316)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  const h = toHistoryEntry(r);
  check(h.runAt === RUN_AT, "履歴に実行日時が入る");
  check(h.overall === "FAIL", "履歴に全体判定が入る");
  check(
    h.metrics[0].previous === 315 && h.metrics[0].current === 316 && h.metrics[0].delta === 1,
    "履歴に前回値・現在値・差分が入る（後から同じ異常を追える）",
  );
}

function testFormatting() {
  const r = compareIntegrity([metric("orphanHistory", 316)], baselineOf({ orphanHistory: 315 }), RUN_AT);
  const text = formatRunResult(r);
  check(text.includes("[FAIL]"), "表示に全体判定が出る");
  check(text.includes("315 → 316"), "表示に前回→現在が出る");
}


/**
 * 走査が1つ失敗しても、他の指標まで巻き込まないこと。
 * ここが崩れると「1テーブルが一時的に読めなかっただけ」で全項目が
 * 取得エラーになり、監視が事実上止まる。
 */
async function testOneFailingScanDoesNotBreakOthers() {
  // Inventory だけ失敗する偽のクライアント。
  const fakeDdb = {
    send: async (cmd: any) => {
      const table = String(cmd?.input?.TableName ?? "");
      if (table === "Inventory") {
        const err = new Error("boom");
        err.name = "ProvisionedThroughputExceededException";
        throw err;
      }
      return { Items: [] };
    },
  } as never;
  const { metrics } = await collectIntegrityMetrics({ ddb: fakeDdb, tableFor: (m) => m });
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  check(
    byKey.get("dupInventorySku")?.value === null,
    "在庫の走査が失敗したら、在庫に依存する指標は取得エラーになる（0件にしない）",
  );
  check(
    byKey.get("dupMessageExternalId")?.value === 0,
    "在庫と無関係な指標は、そのまま数えられる",
    String(byKey.get("dupMessageExternalId")?.value),
  );
  check(
    metrics.filter((m) => m.value === null).length < metrics.length,
    "1つのテーブルが読めなくても、全項目が巻き添えにならない",
    `取得できず ${metrics.filter((m) => m.value === null).length}/${metrics.length}`,
  );
}

/** backend.ts と handler.ts が同じ環境変数名を使っていること。 */
function testTableEnvMapIsShared() {
  check(INTEGRITY_MONITORED_MODELS.length === Object.keys(INTEGRITY_TABLE_ENV).length, "監視対象の一覧と環境変数の表が一致する");
  const bad = INTEGRITY_MONITORED_MODELS.filter((m) => !/^[A-Z0-9_]+_TABLE_NAME$/.test(INTEGRITY_TABLE_ENV[m]));
  check(bad.length === 0, "環境変数名がすべて <MODEL>_TABLE_NAME の形", bad.join(","));
  const dup = new Set(Object.values(INTEGRITY_TABLE_ENV)).size !== INTEGRITY_MONITORED_MODELS.length;
  check(!dup, "環境変数名が重複していない（別モデルが同じテーブルを見に行かない）");
}

async function main() {
  testSameAsBaseline();
  testIncreased();
  testDecreased();
  testFirstRun();
  testMissingBaselineKey();
  testScanErrorDoesNotPoisonBaseline();
  testErrorOnFirstRunDoesNotCreateBaseline();
  testFailWinsOverWarning();
  testRetiredMetricKeepsBaseline();
  testHistoryEntry();
  testFormatting();
  testTableEnvMapIsShared();
  await testOneFailingScanDoesNotBreakOthers();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
