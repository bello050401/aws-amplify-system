/**
 * ZaicoSyncJob の単一行 id。**定義はここだけ**。
 *
 * ## なぜ独立したファイルなのか
 *
 * この値は2つの実行主体が共有する:
 *   - ブラウザ起点の手動advance（lib/inventory/zaicoBackgroundSync.ts）
 *   - スケジュールLambda（amplify/functions/zaico-sync-worker/handler.ts）
 *
 * 以前は両者がそれぞれ自前のリテラルを持っていた。値は同じだったので
 * 動いてはいたが、「どちらの名前が正か」がコード上どこにも書かれておらず、
 * 実際に別のidを指定して**どこからも参照されない行を作ってしまう**事故が
 * 起きた（2026-08-31、運用作業中）。作った行は PENDING だったため、
 * 放置すればUIが「同期実行中」と表示し続ける状態でもあった。
 *
 * zaicoBackgroundSync.ts は `serverDataClient` を通じて "server-only" を
 * 引き込むため、Lambdaから直接importできない。値だけを持つこのファイルを
 * 分けることで、両方から安全に共有できる。
 *
 * ## この行が1つであることの意味
 *
 * ZaicoSyncJob は設計上ちょうど1行しか存在しない（amplify/data/resource.ts
 * のコメント参照）。lease/heartbeat による排他制御が、この「1行」を前提に
 * している。行が増えると、2つの実行主体が別々の行を見て互いのleaseを
 * 無視することになる。
 */
export const ZAICO_SYNC_JOB_ID = "zaico-full-sync-singleton";
