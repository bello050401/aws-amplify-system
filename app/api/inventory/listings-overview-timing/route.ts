import { NextResponse } from "next/server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listListingsOverviewWithTiming } from "@/lib/listing/service";
import { buildTimingResponsePayload } from "@/lib/listing/listingsOverviewTimingResponse";

/**
 * EC一覧(`listListingsOverview`)の段階別サーバー待ち時間を、HTTPレスポンス
 * として直接読むための診断エンドポイント(2026-09-13 「EC計測レビュー
 * 補正」)。
 *
 * ── なぜ専用エンドポイントが要るか ──────────────────────────────
 *
 * `BELLO_QUERY_TIMING=1`(lib/perf/queryTiming.ts)はSSRの標準出力へ
 * `console.info`するだけの既存機構だが、**このアプリのSSRログは
 * CloudWatchへ届かないことが既に判明している**
 * (docs/ssr-logs-investigation-20260902.md /
 * docs/ssr-logs-root-cause-20260902.md — ロググループ自体が作られない)。
 * console出力だけに頼ると、実運用では計測を有効にしても結局読めない。
 *
 * ここではHTTPレスポンス本体で段階別の計測を返す。CloudWatchへのログ
 * 配信状況に依存せず、`curl`やブラウザから直接読める。
 *
 * ── 何を返し、何を返さないか ────────────────────────────────────
 *
 * 返すのは、4本の並列読み取りそれぞれの固定ラベル・壁時計経過時間・
 * 成否(`ListingsOverviewStageTiming`)と、model.opごとの累積往復回数/
 * 所要msの参考値(`ListingsOverviewQueryTotal` — 並列実行された分は
 * そのまま加算されるため壁時計ではないことに注意、
 * lib/perf/queryTiming.tsのgroupTimingsByOp参照)だけ。一覧の行
 * (商品名・価格・画像・出品状況・在庫ID等)は一切含めない ──
 * `listListingsOverviewWithTiming`の戻り値から`rows`を意図的に
 * 読み捨てている。失敗時も、元の例外メッセージ/スタックではなく、
 * どの段階が何msで失敗したかという同じ形の情報だけを返す。
 *
 * ── ゲート(2重) ─────────────────────────────────────────────────
 *
 * 1. 画面(`/inventory/listings`)と同じ閲覧権限 ── 未ログイン/権限外は401。
 * 2. `BELLO_QUERY_TIMING=1`が明示されているときだけ実際にデータへ触れる。
 *    既定(未設定)では`enabled:false`を返すだけで、一覧の読み取りを
 *    一切発生させない ── 誰かがこのURLへ定期アクセスしても、既定では
 *    追加の負荷にならない。
 */
export async function GET() {
  const role = await getInventoryRole();
  if (!role) return new NextResponse("Unauthorized", { status: 401 });

  const { status, body } = await buildTimingResponsePayload(listListingsOverviewWithTiming);
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
