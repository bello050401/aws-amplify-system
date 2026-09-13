import { getStageTimings, isQueryTimingEnabled } from "@/lib/perf/queryTiming";
import type { ListingsOverviewTimedResult } from "@/lib/listing/service";

/**
 * `app/api/inventory/listings-overview-timing/route.ts` の `GET` が返す
 * 応答本体の組み立て(2026-09-13 「EC計測レビュー補正」)。
 *
 * ── なぜ`route.ts`から分離しているか ─────────────────────────────
 *
 * `route.ts`は`getInventoryRole`(next/headersのcookies()が要る)と
 * `lib/listing/service.ts`(Amplifyのcookieクライアント経由でAWSへ実接続
 * する)を読み込む ── どちらもリクエストスコープ/実AWS環境が無いと
 * import自体が失敗する(この開発環境には`amplify_outputs.json`が無い
 * ワークツリーがある)。ここには**それらへの実依存が無い**──
 * `loadTimedOverview`を呼び出し側(`route.ts`の`GET`、または試験用の
 * モック)から差し込む形にすることで、「例外が起きても元の例外
 * メッセージ/スタックを応答へ漏らさない」契約を
 * `scripts/verify-listings-overview-timing.ts`から実コードのまま検証
 * できる(AWSへの接続無しに)。
 *
 * ── 失敗時も「どの段階で何msかかって失敗したか」を返す ────────────
 *
 * 以前は失敗時に`{ error: "listings_overview_failed" }`だけを返し、
 * 4本の並列読み取りのうちどれが失敗したのかが診断応答から読み取れな
 * かった(2026-09-13 レビュー指摘)。`listListingsOverviewWithTiming`が
 * 投げる例外には`lib/perf/queryTiming.ts`の`attachStageTimings`で
 * 添えられた段階別の計測(固定ラベル・壁時計経過時間・成否)が乗って
 * いるので、`getStageTimings`で取り出して返す ── 元の例外メッセージ・
 * スタック・AWS識別子はここでも一切含めない。
 *
 * `getStageTimings`/`isQueryTimingEnabled`は`lib/perf/queryTiming.ts`
 * (AWS/next への依存が無い葉モジュール)からのみ読み込む —— `type`
 * importを除き`@/lib/listing/service`を実行時に読み込まないことで、
 * このファイル自体は`server-only`/Amplify実接続の無い環境でも
 * importでき、`scripts/verify-listings-overview-timing.ts`が実コードを
 * そのまま(mock無しで)検証できる。
 */
export async function buildTimingResponsePayload(
  loadTimedOverview: () => Promise<Pick<ListingsOverviewTimedResult, "stages" | "totalMs" | "queryTotals">>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isQueryTimingEnabled()) {
    return { status: 200, body: { enabled: false } };
  }

  try {
    const { stages, totalMs, queryTotals } = await loadTimedOverview();
    return { status: 200, body: { enabled: true, totalMs, stages, queryTotals } };
  } catch (err) {
    // 例外メッセージはそのまま返さない ── unwrapList系のエラー文言に
    // GraphQLのフィールド名等が乗ることがあるため、固定段階名・壁時計
    // 経過時間・成否だけに絞る(あれば)。
    const stages = getStageTimings(err);
    return { status: 500, body: { enabled: true, error: "listings_overview_failed", stages } };
  }
}
