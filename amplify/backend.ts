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
// せる必要がある。
//
// ── 訂正(staging backend deploy失敗の根本修正) ─────────────────────
// 以前のこのファイルは`new Secret(...)`でこの名前のSecretをCloudForma
// tionが所有する新規resourceとして定義していた。これはproduction App
// (d1uy61lbnqm8ae、main)が最初にこのbackendをデプロイした時点で実際に
// AWSアカウント上へ作成済みであり、それ以降 bello/zaico-api-token は
// 既存の外部リソースとして扱うべきものになっていた。
//
// ところが同じ`amplify/backend.ts`は全ブランチの`ampx pipeline-deploy`
// が共有しており、新しく作成した専用staging App(d4hkkg7dty2du、
// claude/inventory-management-system-5vbvc7)がbackendを初回デプロイし
// た際にも同じ`new Secret(...)`定義が評価され、CloudFormationが同名の
// Secretを新規CREATEしようとして以下で失敗した(実ログで確認済み):
//   AWS::SecretsManager::Secret ZaicoTokenSecretStack/ZaicoApiTokenSecret
//   CREATE_FAILED - "The operation failed because the secret
//   bello/zaico-api-token already exists." (HandlerErrorCode: AlreadyExists)
// この失敗によりstaging backendのCloudFormationデプロイ全体がrollback
// し、Cognito/DynamoDB等の後続resourceもCREATE_FAILED(Resource creation
// cancelled)になっていた — これらは全てこのSecret作成失敗の二次的な
// 結果であり、Cognito/DynamoDB/IAM Trust Policy/WEB_COMPUTE設定自体には
// 問題がなかった。
//
// 修正: このSecretはどの環境(production/staging問わず)でもCDKが新規
// 作成するリソースとして扱わない。`Secret.fromSecretNameV2()`で「この
// 名前を持つ、このstackと同じアカウント/リージョンに既に存在するSecret
// への参照」としてimportする — これによりCloudFormation
// templateにはこのSecretに対応する`AWS::SecretsManager::Secret`
// resourceが一切生成されなくなる(importは合成時の参照であり、実体を
// 持つCFN resourceを生成しない)。Secretの物理的な作成・削除・rename
// はこのCDK定義の管轄外になる — 既存のSecret値(ADMINが設定画面から
// 保存したTOKENを含む)には一切触れない。
//
// これに伴い、以前ここにあった初期値設定(`secretStringValue`で
// `{"configured":false}`を書き込む処理)と`RemovalPolicy.RETAIN`は削除
// した — どちらも「CDKがこのリソースを所有して作成する」場合にのみ意味
// を持つ設定で、importされた既存リソースには適用できない(そもそも
// import時点でSecretは既に存在し、何らかの値を持っている)。
//
// 「Secret resourceを作る」ことと「Secret値を読み書きする」ことの責務
// は完全に分離されている: 前者はAWSアカウント側で既に完了済みの外部事
// 実として扱い、後者(GetSecretValue/PutSecretValue)はlib/zaico/
// secretStore.tsが引き続き担う。CreateSecretが本当に必要かは別途再評
// 価が必要(secretStore.tsのupsertフォールバックコメント参照) — 通常
// 運用ではこのSecretは既にAWS側に存在するため、実行時にCreateSecretの
// パスが呼ばれることは無い。
//
// 重要な制約(変更なし): このSecretへの読み書き権限を、Next.jsのSSR
// コード(lib/zaico/client.ts / app/actions/zaicoSecret.ts)が実際に実
// 行されるAmplify Hostingのコンピュート実行ロールへ、この
// `defineBackend()`からは付与できない — ここで管理しているのは
// Auth/Data/Storage/generateSkuの各Amplifyリソースのみで、Next.js SSR
// を動かすコンピュート(Amplify Hostingの管理下)のIAMロールはこの一覧
// に含まれない。そのため、以下をAmplify Console側でADMINが手動設定する
// 必要がある(完了報告のBLOCKED_BY_USER参照):
//   1. Amplify Console → 該当アプリ → 「App settings」→「IAM roles」
//      (または「Access to AWS resources」)で、SSRコンピュートに割り
//      当てられている実行ロールに、このSecretのARN(バージョン管理用の
//      ランダムsuffixを含む "bello/zaico-api-token-??????" までを対象
//      とする)に対して secretsmanager:GetSecretValue・PutSecretValue
//      を許可するインラインポリシーを追加する(CreateSecret/DeleteSecret
//      はruntimeへ付与しない — Secretは既存の外部リソースであり、
//      runtime側が新規作成・削除する必要は無い)。
//   2. その許可が済むまでは、lib/zaico/client.tsのgetZaicoApiToken()
//      が自動的に既存の環境変数ZAICO_API_TOKENへフォールバックする
//      ため、システムは今まで通り動作し続ける(退行なし)。
export const zaicoTokenSecret = Secret.fromSecretNameV2(backend.stack, "ZaicoApiTokenSecret", "bello/zaico-api-token");
