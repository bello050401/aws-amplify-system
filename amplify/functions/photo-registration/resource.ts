import { defineFunction } from "@aws-amplify/backend";

/**
 * 画像登録基盤 Phase 1 — API境界Lambdaの**候補定義**。
 *
 * 【重要】このファイルは amplify/backend.ts の `defineBackend({...})` へ
 * まだ一切追加していない — `backend.data` / `backend.auth` / `backend.storage`
 * を含む既存構成は今回のタスクで変更しない (指示された制約)。
 * `ampx sandbox` / `ampx pipeline-deploy` は現時点でこのLambdaを一切
 * プロビジョニングしない。デプロイに必要な差分の全量は
 * docs/photo-registration-deployment-plan.md に列挙してあり、そこに
 * 「未適用」と明記している。
 *
 * 実際に接続する際は、他のfunctionと同じ `backend.data.resources.tables`
 * 直接付与パターン (amplify/backend.ts の zaico-sync-worker 節参照) で
 * PhotoRegistration用の新規テーブル (単一テーブル設計、
 * lib/photoRegistration/keys.ts) と既存Inventoryテーブルへ
 * least-privilegeを付与する。
 */
export const photoRegistration = defineFunction({
  name: "photo-registration",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
});
