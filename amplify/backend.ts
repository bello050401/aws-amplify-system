import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { generateSku } from "./functions/generate-sku/resource";

/**
 * Amplify Gen2 backend definition.
 *
 * This app now backs two systems sharing one Auth + one Data API:
 *   - The BASE feature-page generator (Phase 1, unchanged).
 *   - BELLO Inventory (Phase 2 backend foundation added here: new
 *     ADMIN/EDITOR/VIEWER Cognito groups in `auth`, new Inventory-area
 *     models in `data`, and this new `storage` for inventory images).
 *     `generateSku` (added for SKU auto-numbering) is a plain Amplify
 *     Function, not an `a.model()` — see below for the raw CDK table it
 *     needs, which is why it's provisioned here instead of in data/resource.ts.
 *
 * The BASE API and AI provider integrations still run as server-side
 * Next.js route handlers (see app/api/**) rather than as Amplify
 * Functions, so secrets (BASE_CLIENT_SECRET, ANTHROPIC_API_KEY, etc.)
 * live in the Next.js server runtime's environment, never in the client
 * bundle and never in this backend definition.
 */
const backend = defineBackend({
  auth,
  data,
  storage,
  generateSku,
});

// SKU counter table for amplify/functions/generate-sku. This is
// deliberately a plain CDK-provisioned table, not an `a.model()` in
// data/resource.ts: it holds one internal counter row, is never queried
// or mutated by the frontend directly, and has no reason to be exposed
// through the GraphQL API at all — only generateSku's Lambda ever touches
// it (see the grantReadWriteData scoping below, which is IAM-enforced,
// not just "nothing calls it").
const skuCounterStack = backend.createStack("SkuCounterStack");
const skuCounterTable = new Table(skuCounterStack, "SkuCounterTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  // RETAIN, matching Amplify's own model tables: losing this table would
  // reset the counter to zero and start re-issuing already-used SKUs,
  // which is exactly what spec §6 ("一度発行したSKUは原則再利用しない")
  // rules out. A table this small existing after a future stack teardown
  // is a deliberately safe default, not an oversight.
  removalPolicy: RemovalPolicy.RETAIN,
});
skuCounterTable.grantReadWriteData(backend.generateSku.resources.lambda);
backend.generateSku.addEnvironment("SKU_COUNTER_TABLE_NAME", skuCounterTable.tableName);

// ZAICO API TOKENの保存先(夜間開発指示書 §14、lib/zaico/secretStore.ts
// が実際の読み書きを行う)。名前はsecretStore.tsのSECRET_NAMEと一致さ
// せる必要がある。RemovalPolicy.RETAINはskuCounterTableと同じ理由 —
// スタック削除でADMINが設定したTOKENを失うのは事故として大きすぎる。
//
// 重要な制約: このSecretへの読み書き権限を、Next.jsのSSRコード
// (lib/zaico/client.ts / app/actions/zaicoSecret.ts)が実際に実行され
// るAmplify Hostingのコンピュート実行ロールへ、この`defineBackend()`
// からは付与できない — ここで管理しているのはAuth/Data/Storage/
// generateSkuの各Amplifyリソースのみで、Next.js SSRを動かすコンピュー
// ト(Amplify Hostingの管理下)のIAMロールはこの一覧に含まれない。
// そのため、以下のいずれかをAmplify Console側でADMINが手動設定する
// 必要がある(完了報告のBLOCKED_BY_USER参照):
//   1. Amplify Console → 該当アプリ → 「App settings」→「IAM roles」
//      (または「Access to AWS resources」)で、SSRコンピュートに割り
//      当てられている実行ロールに、このSecretのARNを対象とした
//      secretsmanager:GetSecretValue / PutSecretValue / CreateSecret /
//      DeleteSecretを許可するインラインポリシーを追加する。
//   2. その許可が済むまでは、lib/zaico/client.tsのgetZaicoApiToken()
//      が自動的に既存の環境変数ZAICO_API_TOKENへフォールバックする
//      ため、システムは今まで通り動作し続ける(退行なし)。
export const zaicoTokenSecretStack = backend.createStack("ZaicoTokenSecretStack");
export const zaicoTokenSecret = new Secret(zaicoTokenSecretStack, "ZaicoApiTokenSecret", {
  secretName: "bello/zaico-api-token",
  description: "BELLO在庫管理システム — ZAICO API TOKEN(ZAICO→BELLO一方向同期専用、GETのみ)。設定画面(ADMIN限定)から読み書きする。",
  removalPolicy: RemovalPolicy.RETAIN,
});
