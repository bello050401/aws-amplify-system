import { defineFunction } from "@aws-amplify/backend";

/**
 * 売上月次集計(SalesAggregateSnapshot)の定期再構築(2026-09-11 世代整合性
 * 修正指示書)。
 *
 * 引継ぎの経緯: task_90e8b427(「開いたとき即表示する」)が最初にこの
 * Lambdaを設計したが、当worktreeへは未追跡ファイルとして引き継がれて
 * いなかった。task_990f4621が実装した版(月ごとの行へPutItem/DeleteItem
 * を個別発行)を土台にしたが、「1月→2月へ訂正」のような複数月にまたがる
 * 修正の反映中に一部だけ失敗すると、読み手が新旧世代の混在した値を
 * 読んでしまう欠陥があった(docs/sales-aggregate-snapshot-consistency-
 * 20260911.md 参照)。このLambdaは全月ぶんを1アイテム
 * (SalesAggregateSnapshot、"current"固定)へ1回のPutItemで書く設計に
 * 置き換えている——DynamoDBの単一アイテムへの書き込みは原子的なので、
 * 「一部の月だけ新しい世代」という状態がそもそも発生し得ない。
 *
 * ── なぜ「差分」ではなく「全件再計算」なのか ────────────────────
 *
 * 対象の在庫は約5,300件(lib/inventory/salesAggregate.tsの実測コメント
 * 参照)。この規模では全件Scan+再計算の費用が既にごく小さく、差分方式
 * (updatedAtの新しい順に拾って旧寄与を取り消し新寄与を適用する)を
 * 導入する追加の複雑さ・バグ面(境界重複、同時更新、旧月への価格修正の
 * 遡及、販売日の月またぎ移動、削除の検出)に見合わない。全件再計算は
 * 既存設計(scripts/rebuild-sales-aggregate.tsが確立した方針)をそのまま
 * 定期実行に載せるだけで、上記の全ケースを構造的に正しく扱える。
 *
 * ── このLambdaがすること ────────────────────────────────────────
 *
 * 1. Inventory を全件Scan(投影あり、論理削除を除く)。
 * 2. lib/inventory/salesAggregate.ts の buildMonthlyAggregates で月次
 *    集計を作り直す(scripts/rebuild-sales-aggregate.ts と同じ計算)。
 * 3. 全月ぶんをまとめて1つの SalesAggregateSnapshot アイテムへ
 *    ConditionExpression付きPutItemで書く(lib/inventory/
 *    salesAggregateSnapshot.ts 参照)。
 * 4. 実行状態(SalesAggregateRunStatus、1行のみ)を実行前後で更新する。
 *
 * ── 冪等性・部分失敗への耐性 ─────────────────────────────────────
 *
 * PutItemが例外を投げたら、そのPutItemは丸ごと反映されていない
 * (DynamoDBの単一アイテム書き込みは all-or-nothing)——直前まで公開
 * されていた世代のスナップショットは1バイトも変わらず残る。「一部の
 * 月だけ新しい」という混在状態が原理的に作れない。次回のスケジュール
 * 実行(常に全件から作り直す)が自動的に再試行する。
 *
 * ConditionExpression("attribute_not_exists(id) OR generation < :new")
 * により、同時に2つの実行が走っても古い方(startedAtが早い方)が後から
 * 完了しても新しい方を上書きしない(handler.ts参照)。
 *
 * ── 頻度 ────────────────────────────────────────────────────────
 *
 * 12時間ごと(初期値)。lib/inventory/salesAggregateFreshness.ts の
 * SALES_AGGREGATE_SCHEDULE_HOURS と一致させること。
 *
 * ── なぜ新しいサービスを足さないのか ────────────────────────────
 *
 * `defineFunction({ schedule })` がAmplify Gen2ネイティブの EventBridge
 * Scheduler配線を行う。pricing-scheduler/zaico-sync-worker/
 * integrity-monitorと同じ形で、新しいAWSサービスの導入にはならない。
 */
export const salesAggregateScheduler = defineFunction({
  name: "sales-aggregate-scheduler",
  entry: "./handler.ts",
  // pricing-scheduler等と同じ理由(amplify/backend.tsの同コメント参照):
  // Amplify Data管理下のテーブルへgrantReadWriteDataする既定function
  // スタックのままだとdata ⇄ function の循環参照でデプロイ全体が落ちる。
  // dataスタックへ同居させる。
  resourceGroupName: "data",
  // Inventory全件Scan(実測5,313件・投影ありで数百KB)+集計計算+
  // SalesAggregateSnapshotへのPut1回(全月ぶんまとめて数十KB)。
  // integrity-monitor(4万件規模で300秒)より一桁小さい母集団。
  timeoutSeconds: 120,
  memoryMB: 256,
  schedule: "every 12h",
});
