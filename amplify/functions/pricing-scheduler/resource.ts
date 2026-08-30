import { defineFunction } from "@aws-amplify/backend";

/**
 * BELLO統合業務OS §9(PC不在中・完全自律継続実装指示): 完全無人スケジ
 * ュール実行の再検討結果。
 *
 * 【前回投稿までの結論】lib/inventory/zaicoSyncPorts.tsの調査により、
 * `allow.resource(fn)`が使えず、Amplify Dataの`serverDataClient`
 * (Cognitoセッションのcookieを要求)経由でLambdaから安全に書き込む
 * 手段が無い、とされていた。
 *
 * 【今回の再調査で見つかった実際の解決策】
 * 1. `defineFunction({ schedule: "every 1h" })` — Amplify Gen2が
 *    ネイティブに提供するEventBridge Scheduler連携(schedule_parser.d.ts
 *    で型定義を確認済み)。手動でのEventBridge Rule CDK配線は不要。
 * 2. `backend.data.resources.tables['ChannelListing']`
 *    (@aws-amplify/graphql-api-construct/lib/types.d.tsの
 *    `AmplifyGraphqlApiResources.tables: Record<string, ITable>`で
 *    型定義を再確認)経由でIAM(生DynamoDB API)から直接読み書きできる
 *    — AppSync/GraphQLもCognitoセッションも経由しない。
 * 3. 「GSI付きテーブルへの書き込みリスク」を、実際にsynth-checkで
 *    生成されるCloudFormation(Custom::AmplifyDynamoDBTableの
 *    実プロパティ)を読んで再検証した結果: ChannelListingの
 *    GSIキー属性は`listingDraftId`/`inventoryId`という素の
 *    トップレベル属性(computed/hashedな内部属性ではない)。
 *    DynamoDBのUpdateItemはUpdateExpressionで明示した属性しか
 *    変更しないため、`currentPrice`/`markdownCount`/
 *    `lastPriceChangeAt`/`nextPriceActionAt`/`lastAutomationResult`
 *    だけを更新する分には、GSIキー属性(id/listingDraftId/
 *    inventoryId)に一切触れず、GSIを壊すリスクが無い
 *    (handler.tsのUPDATE_ALLOWED_FIELDSがこの境界を強制する)。
 *
 * 【今回のスコープ、正直に】
 * - 対象チャネルはBASEのみ(items/editの実フィールド名を確認済み
 *   のため)。Mercariはupdate系ミューテーションの実schemaが未確認
 *   のため対象外のまま(判定ロジックはlib/listing/pricing.tsを
 *   そのまま再利用)。
 * - BASE OAuthトークンの更新(refresh)はこのLambdaでは行わない
 *   (BaseOAuthTokenテーブルはread-onlyでのみアクセスする) —
 *   トークンが期限切れの場合は「要リフレッシュ(ブラウザでの操作が
 *   必要)」としてPriceExecutionLogへ記録しskipする。既存の
 *   lib/base/oauth.tsのgetAccessToken()がADMINの通常のブラウザ
 *   操作時に自動リフレッシュする経路は変更していない。
 * - 実際のAWSへのdeployはこのsandbox環境のAWS認証情報が無効な
 *   ため未実施(BLOCKED_BY_USER) — コード・IAM権限設定・
 *   synth:checkでのCloudFormation生成確認までがこのラウンドの
 *   到達点(LOCAL_IMPLEMENTED)。
 */
export const pricingScheduler = defineFunction({
  name: "pricing-scheduler",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  // 既定OFFの自動値下げ(§161)対象商品が実際にどれだけあるかに応じて
  // 頻度は調整可能だが、家財おまかせ便の値下げ間隔が「日」単位
  // (PricingRule.intervalDays)である以上、1時間おきで十分な粒度。
  schedule: "every 1h",
});
