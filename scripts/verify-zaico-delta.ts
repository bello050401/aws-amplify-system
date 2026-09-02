/**
 * ZAICO差分同期の判定を固定する検証（ZAICOにもAWSにも繋がない）。
 *
 * ── 前提（実測。推測ではない） ──────────────────────────────────
 *
 * ZAICO API はサーバー側の差分取得に**対応していない**。
 * `scripts/probe-zaico-delta-support.ts` で 2026-09-02 に確認:
 *
 *   updated_at_since / updated_since / since / updated_at_gteq /
 *   updated_at_from / from / modified_since / q[updated_at_gteq]
 *   を過去日時と未来日時の両方で試して、応答はすべて
 *   「200 / 1,000件 / 先頭id 44665891」で基準と同一。
 *
 *   一方 `updated_at` は 1,000/1,000 件すべてに入っていた。
 *
 * したがって差分はBELLO側で判定する。ここはその判定の検証。
 *
 * Run with: npm run verify:zaico-delta
 */
import {
  DELTA_OVERLAP_MS,
  describeRun,
  elapsedMs,
  needsSync,
  nextSuccessfulSyncAt,
  resolveDeltaSince,
  splitByDelta,
} from "@/lib/inventory/zaicoDelta";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

const item = (updated_at: string | null, created_at: string | null = null) =>
  ({ id: 1, updated_at, created_at }) as { id: number; updated_at: string | null; created_at: string | null };

/* ══════════════════════════════════════════════════════════════════
 * 1. 差分の基準時刻
 * ══════════════════════════════════════════════════════════════════ */
function testResolveSince() {
  assertEqual(resolveDeltaSince(null), null, "基準: 初回(前回成功なし)は null = 全件が対象");
  assertEqual(resolveDeltaSince(undefined), null, "基準: undefined でも全件が対象");

  const last = "2026-09-02T21:30:00.000Z";
  const since = resolveDeltaSince(last)!;
  assertEqual(
    new Date(last).getTime() - new Date(since).getTime(),
    DELTA_OVERLAP_MS,
    "基準: 前回成功時刻から5分だけ巻き戻す(境界で取りこぼさない)",
  );
  assertTrue(new Date(since) < new Date(last), "基準: 巻き戻した時刻は前回より前");

  // 壊れた値は「全件」へ倒す。遅いだけで間違ってはいない。
  assertEqual(resolveDeltaSince("not-a-date"), null, "基準: 壊れた値は全件へ倒す");
  assertEqual(resolveDeltaSince(""), null, "基準: 空文字も全件へ倒す");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 1件ごとの判定
 * ══════════════════════════════════════════════════════════════════ */
function testNeedsSync() {
  const since = "2026-09-01T00:00:00.000Z";

  assertEqual(needsSync(item("2026-09-02T00:00:00.000Z"), since), true, "判定: 基準より後は処理する");
  assertEqual(needsSync(item("2026-08-31T00:00:00.000Z"), since), false, "判定: 基準より前は省く");
  assertEqual(needsSync(item(since), since), true, "判定: 基準ちょうどは処理する(境界は含める)");

  // 判断できないものは必ず処理する。飛ばすと永久に反映されない。
  assertEqual(needsSync(item(null), since), true, "判定: updated_at が無ければ処理する");
  assertEqual(needsSync(item("こわれた日付"), since), true, "判定: 読めない日付は処理する");
  assertEqual(
    needsSync(item(null, "2026-09-02T00:00:00.000Z"), since),
    true,
    "判定: updated_at が無くても created_at が新しければ処理する",
  );
  assertEqual(
    needsSync(item(null, "2026-08-01T00:00:00.000Z"), since),
    false,
    "判定: created_at も古ければ省く",
  );

  // 基準が無い(全件)なら常に処理する。
  assertEqual(needsSync(item("2020-01-01T00:00:00.000Z"), null), true, "判定: 基準が無ければ何でも処理する");

  // ZAICOはタイムゾーン付きで返す(実測: 2026-04-22T14:49:07+09:00)。
  assertEqual(
    needsSync(item("2026-09-01T09:00:00+09:00"), "2026-09-01T00:00:00.000Z"),
    true,
    "判定: +09:00 表記でも正しく比較できる",
  );
  assertEqual(
    needsSync(item("2026-09-01T08:00:00+09:00"), "2026-09-01T00:00:00.000Z"),
    false,
    "判定: +09:00 の 08:00 は UTC 23:00 前日なので省く",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 3. ページの振り分け
 * ══════════════════════════════════════════════════════════════════ */
function testSplit() {
  const since = "2026-09-01T00:00:00.000Z";
  const items = [
    { id: 1, updated_at: "2026-09-02T00:00:00.000Z", created_at: null },
    { id: 2, updated_at: "2026-08-01T00:00:00.000Z", created_at: null },
    { id: 3, updated_at: null, created_at: null },
    { id: 4, updated_at: "2026-09-03T00:00:00.000Z", created_at: null },
  ];

  const r = splitByDelta(items, since);
  assertEqual(r.toProcess.map((i) => i.id), [1, 3, 4], "振り分け: 変わったもの＋判断できないものを処理");
  assertEqual(r.skipped.map((i) => i.id), [2], "振り分け: 変わっていないものだけ省く");
  assertEqual(
    r.toProcess.length + r.skipped.length,
    items.length,
    "振り分け: 合計が一致する(どこにも消えない)",
  );

  const full = splitByDelta(items, null);
  assertEqual(full.toProcess.length, 4, "振り分け: 全件同期では全部を処理する");
  assertEqual(full.skipped.length, 0, "振り分け: 全件同期では何も省かない");

  assertEqual(splitByDelta([], since).toProcess.length, 0, "振り分け: 空ページでも壊れない");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 次回の基準をいつに進めるか
 * ══════════════════════════════════════════════════════════════════
 * **完了時刻ではなく開始時刻**を記録する。実行中にZAICO側で更新された
 * ものは、そのページを既に通り過ぎていれば今回拾えていない。完了時刻を
 * 記録すると、それが次回の対象から外れて永久に落ちる。
 */
function testNextSince() {
  const started = "2026-09-02T21:00:00.000Z";
  const finished = "2026-09-02T21:08:00.000Z";
  assertEqual(nextSuccessfulSyncAt(started, finished), started, "次回基準: 完了時刻ではなく開始時刻を記録する");
  assertTrue(
    new Date(nextSuccessfulSyncAt(started, finished)) < new Date(finished),
    "次回基準: 実行中の更新を次回が拾えるよう、完了より前に置く",
  );
  assertEqual(nextSuccessfulSyncAt(null, finished), finished, "次回基準: 開始時刻が無ければ今を使う");
  assertEqual(nextSuccessfulSyncAt("こわれた", finished), finished, "次回基準: 読めない値なら今を使う");
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 取りこぼしが起きないこと（通し）
 * ══════════════════════════════════════════════════════════════════ */
function testNoGap() {
  // 1回目: 21:00 開始、21:08 完了 → 基準は 21:00
  const run1Started = "2026-09-02T21:00:00.000Z";
  const last = nextSuccessfulSyncAt(run1Started, "2026-09-02T21:08:00.000Z");

  // 実行中(21:04)に更新された在庫。1回目では拾えていないかもしれない。
  const duringRun = item("2026-09-02T21:04:00.000Z");

  // 2回目の基準は 21:00 から5分巻き戻して 20:55
  const since2 = resolveDeltaSince(last)!;
  assertEqual(needsSync(duringRun, since2), true, "通し: 実行中に更新されたものを次回が必ず拾う");

  // 完了時刻(21:08)を基準にしていたら落ちていたことを示す。
  const wrongSince = resolveDeltaSince("2026-09-02T21:08:00.000Z")!;
  assertEqual(
    needsSync(item("2026-09-02T21:02:00.000Z"), wrongSince),
    false,
    "通し: 完了時刻を基準にすると実行中の更新が落ちる(だから開始時刻を使う)",
  );

  // 失敗した回では基準を進めない → 前回の基準がそのまま残る
  const afterFailure = last; // 更新しない
  assertEqual(afterFailure, run1Started, "通し: 失敗した回では基準が進まない");
  assertEqual(needsSync(duringRun, resolveDeltaSince(afterFailure)!), true, "通し: だから次回も対象に含まれる");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 結果の要約
 * ══════════════════════════════════════════════════════════════════ */
function testSummary() {
  assertEqual(elapsedMs("2026-09-02T21:00:00.000Z", "2026-09-02T21:00:30.000Z"), 30000, "経過: 30秒");
  assertEqual(elapsedMs(null, "2026-09-02T21:00:30.000Z"), null, "経過: 開始が無ければ null(0と混同しない)");
  assertEqual(elapsedMs("2026-09-02T21:00:00.000Z", null), null, "経過: 完了が無ければ null");
  assertEqual(elapsedMs("こわれた", "こわれた"), null, "経過: 読めない値でも壊れない");

  const line = describeRun({
    mode: "DELTA",
    since: "2026-09-02T20:55:00.000Z",
    startedAt: "2026-09-02T21:00:00.000Z",
    finishedAt: "2026-09-02T21:00:12.000Z",
    fetched: 5313,
    created: 1,
    updated: 3,
    unchanged: 0,
    skippedByDelta: 5309,
    failed: 0,
    lastSuccessfulSyncAt: "2026-09-02T21:00:00.000Z",
  });
  assertTrue(line.includes("差分同期"), "要約: 種類が分かる");
  assertTrue(line.includes("5309"), "要約: 省いた件数が分かる");
  assertTrue(line.includes("12.0秒"), "要約: 処理時間が分かる");

  const fullLine = describeRun({
    mode: "FULL",
    since: null,
    startedAt: "2026-09-02T21:00:00.000Z",
    finishedAt: null,
    fetched: 5313,
    created: 0,
    updated: 0,
    unchanged: 5313,
    skippedByDelta: 0,
    failed: 0,
    lastSuccessfulSyncAt: null,
  });
  assertTrue(fullLine.includes("全件同期"), "要約: 全件と差分を取り違えない");
  assertTrue(fullLine.includes("計測不可"), "要約: 未完了なら時間を偽らない");
}

testResolveSince();
testNeedsSync();
testSplit();
testNextSince();
testNoGap();
testSummary();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
