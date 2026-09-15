/**
 * 売上着地予測(lib/inventory/sales.ts の calculateMonthEndForecast /
 * forecastReferenceDay)の回帰テスト。
 *
 * ── 経緯 ────────────────────────────────────────────────────────
 *
 * 1. 2026-09-15 スナップショット整合性修正: SalesAggregateSnapshot
 *    (totalSalesの元データ)は12時間おきにしか再構築されない。以前は
 *    着地予測の分母(elapsedDays)に「画面を開いた瞬間のJSTの今日」
 *    (nowInJst().day)をそのまま使っていたため、集計の再構築時刻と画面
 *    を開いた時刻がずれると、totalSalesが実際に反映している日数と分母
 *    が食い違っていた(実測: 9/14 21:00 JST時点の集計2,407,020円を9/15
 *    朝に開くと、15で割って160,468円/日と表示されたが、正しくは9/14
 *    までの14日ぶんなので14で割った171,930円/日のはず)。
 *
 * 2. 2026-09-15 異常系表示修正: 上記1の初版は、rebuiltAtの解析に失敗
 *    した場合/表示対象と別月の場合に「今日」へフォールバックしていた
 *    が、これは「根拠不明な集計日時に対して根拠不明の分母で予測を計算
 *    して表示してしまう」問題を残していた。加えて、rebuiltAtが閲覧時刻
 *    より未来を指す異常系(クロックスキュー等)も未対応だった。
 *    forecastReferenceDayは現在、正常系(rebuiltAtが解析でき、表示対象
 *    のJST年月と一致し、閲覧時刻以前)のときだけ{ok:true, day}を返し、
 *    それ以外(不正/別月/未来)は{ok:false, reason}を返す——呼び出し側
 *    (sales/page.tsx)はok:falseのとき着地予測を表示しない(売上高本体は
 *    維持する)。
 *
 * 実行: npx tsx scripts/verify-sales-forecast-snapshot-alignment.ts
 *       (このファイルが依存するlib/inventory/sales.tsは純粋関数のみで
 *        server-only/AWS依存が無いため、with-server-only-stub等は不要)
 */
import { calculateMonthEndForecast, forecastReferenceDay, isCurrentJstYearMonth, daysInMonth } from "@/lib/inventory/sales";

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

// JST日時をUTCのDateへ変換するヘルパ(テストのfixture用途のみ)。
function jstToUtcDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

// ── シナリオ1: 前日21時JSTのsnapshotを翌朝JSTに表示(報告された不具合そのもの) ──
console.log("── シナリオ1: 前日21時snapshotを翌朝表示 ──");
{
  const rebuiltAt = jstToUtcDate(2026, 9, 14, 21, 0).toISOString(); // 2026-09-14 21:00 JST
  const viewedAt = jstToUtcDate(2026, 9, 15, 8, 0); // 2026-09-15 08:00 JST に画面を開く
  const totalSales = 2407020;

  const result = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(result.ok === true, "正常系(ok:true)と判定される", JSON.stringify(result));
  const day = result.ok ? result.day : NaN;
  check(day === 14, "分母の日はsnapshot再構築時点(9/14)を使う——閲覧時点(9/15)ではない", String(day));

  const forecast = calculateMonthEndForecast(totalSales, 2026, 9, day);
  check(forecast.elapsedDays === 14, "elapsedDays=14", String(forecast.elapsedDays));
  check(Math.round(forecast.averageDailySales) === 171930, "1日平均売上=2,407,020÷14=171,930円", String(Math.round(forecast.averageDailySales)));
  check(
    Math.round(forecast.projectedMonthEndSales) === Math.round(171930 * 30),
    "着地予測=171,930×30日",
    String(Math.round(forecast.projectedMonthEndSales)),
  );

  // 修正前の実装(nowInJst().day=15をそのまま使う)だと不当に下がっていたことの確認。
  const buggyForecast = calculateMonthEndForecast(totalSales, 2026, 9, 15);
  check(Math.round(buggyForecast.averageDailySales) === 160468, "(参考)旧実装は15で割って160,468円になっていた", String(Math.round(buggyForecast.averageDailySales)));
  check(
    Math.round(forecast.averageDailySales) > Math.round(buggyForecast.averageDailySales),
    "修正後は日付が変わっただけで予測が不当に下がらない(修正後 > 旧バグ値)",
  );
}

// ── シナリオ2: 当日中に再構築されたsnapshotをそのまま同日中に表示 ──
console.log("\n── シナリオ2: 当日snapshot(再構築時刻=閲覧日と同じ) ──");
{
  const rebuiltAt = jstToUtcDate(2026, 9, 15, 3, 0).toISOString(); // 2026-09-15 03:00 JST
  const viewedAt = jstToUtcDate(2026, 9, 15, 20, 0); // 同日20:00 JSTに閲覧
  const result = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(result.ok === true && result.day === 15, "再構築日=閲覧日が同じ日ならそのまま15を使う(従来どおりの体感を維持)", JSON.stringify(result));
}

// ── シナリオ3: 過去月は着地予測の対象外(呼び出し側=page.tsxの責務だが、判定関数自体を確認) ──
console.log("\n── シナリオ3: 過去month判定 ──");
{
  const referenceNow = jstToUtcDate(2026, 9, 15, 12, 0);
  check(isCurrentJstYearMonth(2026, 8, referenceNow) === false, "先月(8月)はisCurrentJstYearMonth=false(着地予測を出さない対象)");
  check(isCurrentJstYearMonth(2026, 9, referenceNow) === true, "当月(9月)はisCurrentJstYearMonth=true");
}

// ── シナリオ4: 月初JST境界(9/1 00:05 JSTに再構築されたsnapshotを9/1朝に表示) ──
console.log("\n── シナリオ4: 月初JST境界 ──");
{
  const rebuiltAt = jstToUtcDate(2026, 9, 1, 0, 5).toISOString();
  const viewedAt = jstToUtcDate(2026, 9, 1, 9, 0);
  const result = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(result.ok === true && result.day === 1, "月初1日はelapsedDays=1として扱われる(0除算にならない)", JSON.stringify(result));
  const day = result.ok ? result.day : NaN;
  const forecast = calculateMonthEndForecast(30000, 2026, 9, day);
  check(forecast.elapsedDays === 1 && Math.round(forecast.averageDailySales) === 30000, "初日は1日平均=累計売上そのもの", JSON.stringify(forecast));
}

// ── シナリオ4b: 月末→翌月境界(9/30 23:55 JST再構築のsnapshotを10/1 00:10 JSTに表示) ──
console.log("\n── シナリオ4b: 月跨ぎ境界(9月末snapshotを10月表示中に見る) ──");
{
  const rebuiltAt = jstToUtcDate(2026, 9, 30, 23, 55).toISOString();
  const viewedAt = jstToUtcDate(2026, 10, 1, 0, 10);
  // 10月分を表示しているのに集計はまだ9月のsnapshot——月が違うので不可。
  const result = forecastReferenceDay(rebuiltAt, 2026, 10, viewedAt);
  check(result.ok === false && result.reason === "different-month", "10月表示中に9月snapshotしか無ければ予測不可(different-month)", JSON.stringify(result));
  // 同じsnapshotを9月分の表示として見れば正常系(9/30、月末=elapsedDays=totalDaysInMonth)。
  const sameMonth = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(sameMonth.ok === true && sameMonth.day === 30, "同じsnapshotを9月表示として見れば正常系(9/30)", JSON.stringify(sameMonth));
}

// ── シナリオ5: rebuiltAtが対象年月とズレている異常系(予測を出さない) ──
console.log("\n── シナリオ5: rebuiltAtのJST年月が表示対象とズレている異常系 ──");
{
  // rebuiltAtが8月(想定外——通常はこのデータがそもそも"ok"にならないはずの保険ケース)なのに9月を表示。
  const rebuiltAt = jstToUtcDate(2026, 8, 31, 10, 0).toISOString();
  const viewedAt = jstToUtcDate(2026, 9, 15, 12, 0);
  const result = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(
    result.ok === false && result.reason === "different-month",
    "対象年月とrebuiltAtの年月が一致しない場合は予測を出さない(根拠不明の数字を表示しない)",
    JSON.stringify(result),
  );
}

// ── シナリオ6: 未集計/ゼロ(0円運用) ──
console.log("\n── シナリオ6: 未集計/ゼロ ──");
{
  const forecast = calculateMonthEndForecast(0, 2026, 9, 14);
  check(forecast.averageDailySales === 0 && forecast.projectedMonthEndSales === 0, "累計売上0円なら平均・着地予測とも0円(0除算にならない)", JSON.stringify(forecast));
}

// ── シナリオ7: 不正なrebuiltAt文字列 ──
console.log("\n── シナリオ7: 不正なrebuiltAt文字列でも予測を出さない ──");
{
  const viewedAt = jstToUtcDate(2026, 9, 15, 12, 0);
  const result = forecastReferenceDay("not-a-date", 2026, 9, viewedAt);
  check(result.ok === false && result.reason === "invalid", "解析できないrebuiltAtはinvalidとして予測を出さない(例外にもならない)", JSON.stringify(result));
}

// ── シナリオ7b: 未来日時のrebuiltAt(クロックスキュー等の異常系) ──
console.log("\n── シナリオ7b: rebuiltAtが閲覧時刻より未来 ──");
{
  const viewedAt = jstToUtcDate(2026, 9, 15, 12, 0);
  const rebuiltAt = jstToUtcDate(2026, 9, 15, 12, 1).toISOString(); // 閲覧時刻より1分だけ未来
  const result = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(result.ok === false && result.reason === "future", "閲覧時刻より未来のrebuiltAtはfutureとして予測を出さない", JSON.stringify(result));

  // 未来だが日付は同じ(2026-09-15)——それでも「未来」判定を優先し、日付が
  // 一致しているからといって正常系扱いにしないことを確認する。
  const stillFuture = forecastReferenceDay(rebuiltAt, 2026, 9, viewedAt);
  check(stillFuture.ok === false, "同じJST日でも閲覧時刻より未来なら予測を出さない(根拠不明を優先)", JSON.stringify(stillFuture));

  // ちょうど同時刻(未来ではない)は正常系。
  const exact = forecastReferenceDay(viewedAt.toISOString(), 2026, 9, viewedAt);
  check(exact.ok === true && exact.day === 15, "rebuiltAt=閲覧時刻ちょうどは未来扱いしない(境界値)", JSON.stringify(exact));
}

// ── シナリオ8: daysInMonthとの整合(閏年を含む) ──
console.log("\n── シナリオ8: 月の日数が正しく反映される ──");
{
  check(daysInMonth(2028, 2) === 29, "2028年は閏年で2月は29日", String(daysInMonth(2028, 2)));
  const forecast = calculateMonthEndForecast(29000, 2028, 2, 29);
  check(forecast.totalDaysInMonth === 29 && forecast.elapsedDays === 29, "2月29日時点でelapsedDays=totalDaysInMonth=29(着地予測=累計そのもの)", JSON.stringify(forecast));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
