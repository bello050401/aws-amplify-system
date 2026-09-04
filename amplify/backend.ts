import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy, SecretValue } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { generateSku } from "./functions/generate-sku/resource";
import { pricingScheduler } from "./functions/pricing-scheduler/resource";
import { imageProcessingWorker } from "./functions/image-processing-worker/resource";
import { zaicoSyncWorker } from "./functions/zaico-sync-worker/resource";
import { integrityMonitor } from "./functions/integrity-monitor/resource";

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
  pricingScheduler,
  imageProcessingWorker,
  zaicoSyncWorker,
  integrityMonitor,
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

// Mercari Shops Personal API Access Token(BELLO統合改修 master指示書
// Phase D、lib/listing/mercari/secretStore.tsが実際の読み書きを行う)。
//
// ZAICOのSecretと違い、こちらはこのアプリがAWSアカウント上に存在させる
// 初めての実体 — production/staging問わず、`bello/mercari-access-token`
// という名前のSecretはまだAWS側に存在しない。そのためZAICOのような
// `Secret.fromSecretNameV2()`(既存の外部リソースへの参照 — CFN resource
// を一切生成しない)ではなく、CDKが実際に所有・作成する
// `new Secret(...)`を使う。これはZAICOのSecretが元々そう定義されていて、
// production初回デプロイ後の別App(staging)向け再デプロイで
// "AlreadyExists"衝突を起こした、その同じ形そのものだが — Mercariの
// SecretはどのApp/環境向けにも初回デプロイであり、事前にAWS側へ存在
// する実体がまだ無いため、この状況では発生し得ない(ZAICOの障害は
// 「CDK管理外で既に存在するリソースをCDKが新規作成しようとした」ことが
// 原因であり、「CDKでリソースを新規作成すること自体」が問題だったわけ
// ではない — zaicoTokenSecretの上のコメント参照)。
//
// RemovalPolicy.RETAIN: このSecret(ADMINが設定画面から保存した実際の
// Personal API Access Tokenを含む)は、スタックの削除・再作成があっても
// 誤って失われてはならない — zaicoTokenSecret運用開始前のSecretが本来
// 持つべきだった性質と同じ。
// ── 実測に基づく補足(2026-08-30、staging build job#64以降) ──────────
// 上の「どのApp/環境向けにも初回デプロイなので衝突は発生し得ない」と
// いう前提は、bello/mercari-access-tokenについては今も成立している
// **が、それはこのSecretを最初に作成したのがstaging App
// (d4hkkg7dty2du)側だったからに過ぎない**:
//   aws secretsmanager list-secrets の実データ
//     bello/mercari-access-token  created 2026-08-29T22:51 JST
//     owning stack: amplify-d4hkkg7dty2du-...-MercariApiTokenSecretStack...
// つまりstaging Appにとっては自分が所有するリソースのUPDATEなので正常
// に通るが、**同じbranchが自動ビルドで繋がっているもう一方のApp
// (d1uy61lbnqm8ae)にとっては「CDK管理外で既に存在するSecretを新規作成
// しようとする」状態**であり、そちらのビルドは
//   CREATE_FAILED ... "the secret bello/mercari-access-token already
//   exists." (HandlerErrorCode: AlreadyExists)
// で失敗し続けている(job#69のログで確認済み — 当該branchの全50 job
// が失敗、成功は一度も無い)。
//
// これをzaicoTokenSecret/lineChannelSecretと同じ`fromSecretNameV2()`
// importへ揃えれば構造的には最も一貫するが、その変更はもう一方のApp
// のバックエンドデプロイを実際に成功させてしまう。d1uy61lbnqm8aeへの
// 変更は現在の作業方針で明示的に禁止されているため、この判断は意図的に
// 保留してある——「気づいていない」のではなく「意図的に触っていない」。
// 解禁の判断が出た時点で、このブロックもfromSecretNameV2()へ揃えること。
const mercariTokenSecretStack = backend.createStack("MercariApiTokenSecretStack");
export const mercariTokenSecret = new Secret(mercariTokenSecretStack, "MercariApiTokenSecret", {
  secretName: "bello/mercari-access-token",
  description: "BELLO在庫管理システム — Mercari Shops Personal API Access Token(EC出品機能専用)。設定画面(ADMIN限定)から読み書きする。",
  secretStringValue: SecretValue.unsafePlainText(JSON.stringify({ configured: false })),
  removalPolicy: RemovalPolicy.RETAIN,
});

// 重要な制約(ZAICOと全く同じ理由 — 上のzaicoTokenSecretコメント参照):
// このSecretへの読み書き権限を、Next.jsのSSRコード
// (lib/listing/mercari/secretStore.ts)が実際に実行されるAmplify
// HostingのSSRコンピュート実行ロールへ、この`defineBackend()`からは
// 付与できない。以下をAmplify Console側でADMINが手動設定する必要が
// ある(完了報告のBLOCKED_BY_USER参照):
//   1. Amplify Console → 該当アプリ → 「App settings」→「IAM roles」
//      で、SSRコンピュート実行ロールに、このSecretのARN
//      ("bello/mercari-access-token-??????")に対して
//      secretsmanager:GetSecretValue・PutSecretValueを許可する
//      インラインポリシーを追加する。
//   2. その許可が済むまでは、lib/listing/mercari/tokenAccess.tsの
//      getMercariAccessToken()が自動的に環境変数
//      MERCARI_ACCESS_TOKENへフォールバックする(退行なし)。
//   3. ZAICOと異なりこのSecretはCDKが所有しているため、
//      `ampx pipeline-deploy`が実際にAWSへ接続してデプロイできる状態
//      になれば、上記1のIAM権限設定を除き、Secret自体の作成は自動的に
//      行われる(手動でのCreateSecretは不要)。

// BELLO統合業務OS指示書(2026-08-30) §51-52: LINE公式アカウントの
// Channel Secret(Webhook署名検証用)+ Channel Access Token(Reply/Push
// 送信用)。lib/messaging/lineSecretStore.tsが実際の読み書きを行う。
//
// ── 訂正(staging build job#64の実測結果に基づく) ───────────────────
// このSecretは当初、上のmercariTokenSecretと同じ`new Secret(...)`
// (CDKが所有・作成するリソース)として定義されていた。その前提は
// 「`bello/line-channel-secret`という名前のSecretはまだAWS側に存在
// しない」だったが、これは実測の結果**誤りだった**:
//
//   aws secretsmanager list-secrets の実データ
//     bello/line-channel-secret  created 2026-08-30T11:36 JST
//     owning stack: amplify-d1uy61lbnqm8ae-...-LineChannelSecretStack...
//
// つまりこのSecretは、同じbranchへ自動ビルドが繋がっているもう一方の
// App(d1uy61lbnqm8ae)側のデプロイによって、既にAWSアカウント上へ実体
// として作成済みだった。そのため専用staging App(d4hkkg7dty2du)の
// backendデプロイでは、zaicoTokenSecretが辿ったのと全く同じ経路で
// CloudFormationが失敗していた(job#64のビルドログで確認済み):
//   AWS::SecretsManager::Secret LineChannelSecretStack/LineChannelSecret
//   CREATE_FAILED - "The operation failed because the secret
//   bello/line-channel-secret already exists." (HandlerErrorCode:
//   AlreadyExists)
// この1件の失敗でstaging backend全体がrollbackし、storage/functionの
// 各nested stackもUPDATE_FAILED(Resource update cancelled)になっていた
// — これらは全てこのSecret作成失敗の二次的な結果である。
//
// 修正: zaicoTokenSecretと同一の扱いにする。`Secret.fromSecretNameV2()`
// で「この名前を持つ、同じアカウント/リージョンに既に存在するSecretへの
// 参照」としてimportする — CloudFormation templateにこのSecretに対応
// する`AWS::SecretsManager::Secret`リソースは一切生成されなくなり、
// Secretの物理的な作成・削除はこのCDK定義の管轄外になる。ADMINが設定
// 画面から保存した実際のChannel Secret/Access Token値には一切触れない。
//
// 併せて`backend.createStack("LineChannelSecretStack")`も削除した —
// importは実体を持つCFNリソースを生成しないため、そのためだけの専用
// nested stackは空になり存在意義が無い(zaicoTokenSecretが
// `backend.stack`へ直接importしているのと同じ形に揃える)。
// 既にこのnested stackを持っているApp側では、次回デプロイでこの空
// スタックが削除されるが、削除前のテンプレートでSecretへ
// `RemovalPolicy.RETAIN`が設定されていたため、Secretの実体はCFNの
// 管理から外れる(orphan)だけで削除されない — zaicoTokenSecretを
// importへ移行した際(commit 61f8ec2)と同じ挙動。
//
// IAM権限に関する制約はmercariTokenSecret/zaicoTokenSecretと同じ
// (SSRコンピュート実行ロールへの付与はAmplify Console側でADMINが手動
// 設定する必要がある — 上のコメント参照)。
export const lineChannelSecret = Secret.fromSecretNameV2(backend.stack, "LineChannelSecret", "bello/line-channel-secret");

// ─────────────────────────────────────────────────────────────────────
// BELLO統合業務OS §9(PC不在中・完全自律継続実装指示): Pricing Rule
// Engineの完全無人スケジュール実行(EventBridge Scheduler→Lambda)。
// amplify/functions/pricing-scheduler/resource.tsのファイル冒頭コメ
// ント参照 — defineFunctionの`schedule`オプションが実際のEventBridge
// Scheduler配線を行う(ここでの手動CDK配線は不要)。ここで行うのは:
//   1. PriceExecutionLogテーブル(生CDK、GSI無し — skuCounterTableと
//      全く同じ理由・同じパターン)の新設。
//   2. 各テーブルへの最小権限IAM付与(read-only/read-writeを明確に
//      区別 — handler.tsのコメント参照)。
// ─────────────────────────────────────────────────────────────────────
const priceExecutionLogStack = backend.createStack("PriceExecutionLogStack");
const priceExecutionLogTable = new Table(priceExecutionLogStack, "PriceExecutionLogTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.RETAIN, // 監査ログのため、スタック再作成時にも失われてはならない(skuCounterTableと同じ判断)。
});
priceExecutionLogTable.grantReadWriteData(backend.pricingScheduler.resources.lambda);
backend.pricingScheduler.addEnvironment("PRICE_EXECUTION_LOG_TABLE_NAME", priceExecutionLogTable.tableName);

// Amplify Data管理下のテーブルへは、AppSync/GraphQL/Cognitoセッション
// を一切経由せず、IAM(生DynamoDB API)から直接アクセスする —
// backend.data.resources.tablesの型はAmplifyGraphqlApiResources.tables:
// Record<string, ITable>として実在を確認済み(node_modules内で再確認、
// lib/inventory/zaicoSyncPorts.tsが以前確認していたのと同じAPI)。
//
// 権限の考え方(handler.tsの実装と対になる境界):
//   - ChannelListing: read(Scanで対象抽出)+ write(価格関連フィールド
//     のみに限定したUpdateItem — GSIキー属性(id/inventoryId/
//     listingDraftId)には触れないことをhandler.ts側のコードで強制)。
//   - PricingRule: read-onlyのみ(ルール自体はこのLambdaから変更しない)。
//   - BaseOAuthToken: read-onlyのみ(トークンのリフレッシュはこの
//     Lambdaでは行わない — resource.tsのファイル冒頭コメント参照)。
const channelListingTable = backend.data.resources.tables["ChannelListing"];
const pricingRuleTable = backend.data.resources.tables["PricingRule"];
const baseOAuthTokenTable = backend.data.resources.tables["BaseOAuthToken"];

channelListingTable.grantReadWriteData(backend.pricingScheduler.resources.lambda);
pricingRuleTable.grantReadData(backend.pricingScheduler.resources.lambda);
baseOAuthTokenTable.grantReadData(backend.pricingScheduler.resources.lambda);

backend.pricingScheduler.addEnvironment("CHANNEL_LISTING_TABLE_NAME", channelListingTable.tableName);
backend.pricingScheduler.addEnvironment("PRICING_RULE_TABLE_NAME", pricingRuleTable.tableName);
backend.pricingScheduler.addEnvironment("BASE_OAUTH_TOKEN_TABLE_NAME", baseOAuthTokenTable.tableName);

// ─────────────────────────────────────────────────────────────────────
// BELLO画像自動加工システム(2026-08-30指示書)§14: ProcessingJobキュー
// を処理する完全無人Lambda(amplify/functions/image-processing-worker/
// resource.tsのコメント参照)。pricing-schedulerと同じIAM直接付与
// パターン + S3(backend.storage.resources.bucket、@aws-amplify/
// backend-storageのIBucket型で実在確認済み)への読み書きを追加する。
//
// 権限の考え方:
//   - ProcessingJob: read(Scanで対象抽出)+ write(status/attemptCount/
//     errorMessage等の限定フィールドのみへのUpdateItem。GSIを持たない
//     テーブルなのでUpdateItem自体に構造的なGSI破壊リスクが無い)。
//   - ImageProcessingVersion: write(新規行の作成、旧activeの降格)。
//     GSI(secondaryIndexes(imageStorageKey))を持つが、このLambdaが
//     書くのはid指定のUpdateItem(active/statusのみ)か新規PutItemの
//     どちらかで、GSIキー属性(imageStorageKey)自体を書き換える
//     UpdateItemは一切行わない——pricing-schedulerで確立した安全原則
//     と同じ。
//   - PhotoProfile: read-onlyのみ(ACTIVE Profileのversion/調整値を
//     参照するだけ、更新はUIから行う)。
//   - Inventory: read-onlyのみ(画像のclassification/isPrimaryを読む
//     だけ——処理結果はInventory.imagesへは一切書き込まない、上記
//     InventoryImage customTypeコメントの設計判断)。
//   - S3(inventory/*プレフィックス): オリジナルのread + 派生画像の
//     write。バケット全体ではなくprefixスコープのIAM policyにする
//     (amplify/storage/resource.tsの既存のinventory/*境界を尊重)。
const processingJobTable = backend.data.resources.tables["ProcessingJob"];
const imageProcessingVersionTable = backend.data.resources.tables["ImageProcessingVersion"];
const photoProfileTable = backend.data.resources.tables["PhotoProfile"];
const inventoryTable = backend.data.resources.tables["Inventory"];

processingJobTable.grantReadWriteData(backend.imageProcessingWorker.resources.lambda);
imageProcessingVersionTable.grantReadWriteData(backend.imageProcessingWorker.resources.lambda);
photoProfileTable.grantReadData(backend.imageProcessingWorker.resources.lambda);
inventoryTable.grantReadData(backend.imageProcessingWorker.resources.lambda);
backend.storage.resources.bucket.grantRead(backend.imageProcessingWorker.resources.lambda, "inventory/*");
backend.storage.resources.bucket.grantPut(backend.imageProcessingWorker.resources.lambda, "inventory/processed/*");
backend.storage.resources.bucket.grantPut(backend.imageProcessingWorker.resources.lambda, "inventory/thumbnails/*");

backend.imageProcessingWorker.addEnvironment("PROCESSING_JOB_TABLE_NAME", processingJobTable.tableName);
backend.imageProcessingWorker.addEnvironment("IMAGE_PROCESSING_VERSION_TABLE_NAME", imageProcessingVersionTable.tableName);
backend.imageProcessingWorker.addEnvironment("PHOTO_PROFILE_TABLE_NAME", photoProfileTable.tableName);
backend.imageProcessingWorker.addEnvironment("INVENTORY_TABLE_NAME", inventoryTable.tableName);
backend.imageProcessingWorker.addEnvironment("STORAGE_BUCKET_NAME", backend.storage.resources.bucket.bucketName);

// ─────────────────────────────────────────────────────────────────────
// AI Vision(2026-08-31 AI Vision統合仕様書 §33): 難例だけの意味解析
// フォールバックとして image-processing-worker から Amazon Bedrock を
// 呼べるようにする。
//
// ## なぜ Amazon Nova で、Anthropic Claude ではないのか
//
// 実測した結果、このアカウントで Anthropic モデルを呼ぶとモデルを問わず
// `404 Model use case details have not been submitted for this account.`
// になる(利用者本人によるフォーム提出が要る)。一方 Nova は申請なしで
// そのまま応答した。us-west-2 には Anthropic 以外に画像入力対応モデルが
// 27件あり、必要なのは「商品はここ / これは撮影機材」という座標と分類
// だけなので Nova Lite で足りる。実機で丸テーブルを confidence 0.95 で
// 判定し、右端の撮影機材も検出できている。利用者の AWS 操作を1つも
// 増やさない(§8 の優先順位)。
//
// ## クロスリージョン推論プロファイルに必要な権限
//
// 既定のモデルIDは `us.` 接頭辞つきの**推論プロファイル**である。
// プロファイル自身の ARN に加えて、**そのプロファイルがルーティングし得る
// 全リージョンの基盤モデル ARN** を許可しないと AccessDeniedException に
// なる(プロファイル ARN だけでは足りない)。ルーティング先は
// `aws bedrock get-inference-profile` で実測して列挙している。
//
// 基盤モデル ARN にアカウントIDが入らないのは仕様(AWS 所有のリソース)。
const VISION_MODEL = "amazon.nova-lite-v1:0";
const VISION_PROFILE = "us.amazon.nova-lite-v1:0";
/** 推論プロファイルのルーティング先。get-inference-profileの実測値。 */
const VISION_MODEL_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];

backend.imageProcessingWorker.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["bedrock:InvokeModel"],
    resources: [
      // 推論プロファイル本体(呼び出し先として指定するID)
      `arn:aws:bedrock:${backend.stack.region}:${backend.stack.account}:inference-profile/${VISION_PROFILE}`,
      // プロファイルがルーティングし得る各リージョンの基盤モデル
      ...VISION_MODEL_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${VISION_MODEL}`),
    ],
  }),
);

// 既定では無効。AIを足すこと自体は品質改善ではないため(§56)、明示的に
// 有効化したときだけ使う。予算はLambdaのtimeout(300秒)を守るための上限で、
// 使い切ったら静かにローカル解析へ戻る(BudgetedVisionAnalyzer参照)。
backend.imageProcessingWorker.addEnvironment("BELLO_VISION_ENABLED", "true");
backend.imageProcessingWorker.addEnvironment("BELLO_VISION_MODEL_ID", VISION_PROFILE);
backend.imageProcessingWorker.addEnvironment("BELLO_VISION_REGION", backend.stack.region);
backend.imageProcessingWorker.addEnvironment("BELLO_VISION_MAX_CALLS_PER_RUN", "3");
backend.imageProcessingWorker.addEnvironment("BELLO_VISION_MAX_MS_PER_RUN", "90000");


// ─────────────────────────────────────────────────────────────────────
// BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期の完全無人化。
// amplify/functions/zaico-sync-worker/resource.tsのコメント参照 —
// pricing-scheduler/image-processing-workerと同じ
// `backend.data.resources.tables[...].grantReadWriteData(fn)`パターン
// をInventory本体へ初めて適用する(このラウンドでsynth生成の実
// CloudFormationからGSI安全性を確認して初めて可能になった)。
//
// 権限の考え方:
//   - Inventory: read+write(新規作成・既存更新の両方。GSIキー属性
//     (id/sku/categoryId/statusId/locationId/deletedAt)は全て素の
//     トップレベル属性であることを確認済み——lambdaSyncPort.tsの
//     コメント参照)。
//   - Category/Location: read+write(findOrCreate — 新規カテゴリ/
//     場所の作成もZAICO同期の正当な範囲、既存のNext.js側実装と同じ)。
//   - InventoryHistory: read+write(このLambdaは読み取らないが、
//     grantWriteDataのみだと将来の変更履歴閲覧機能追加時に権限不足で
//     気づきにくいため、他のBELLO全体の慣行(常にread+write単位で
//     付与)に合わせる——実際に使うのはPutItemのみ)。
//   - ZaicoSyncJob: read+write(checkpoint/lease/heartbeatの読み書き)。
//   - S3(inventory/*): read+write(ZAICO画像のオリジナル保存先は
//     `inventory/`直下——image-processing-workerと違い派生画像限定
//     ではない、ZAICO同期が扱うのは常に「オリジナル画像の新規保存」
//     のため)。
//   - Secrets Manager(bello/zaico-api-token): read専用。このLambda
//     自身の実行ロールはdefineBackend()の管理下にあるため、Next.js
//     SSRコンピュートと違い、Amplify Console側の手動IAM設定なしに
//     ここから直接grantできる(zaicoTokenSecret宣言の上のコメントが
//     説明する「SSRコンピュートへは付与できない」制約は、この
//     Lambda実行ロールには適用されない)。
//   - generate-sku Lambda: lambda:InvokeFunction専用(SKU発番ロジック
//     を複製せず、既存の正しい実装をそのまま呼び出す)。
const categoryTable = backend.data.resources.tables["Category"];
const locationTable = backend.data.resources.tables["Location"];
const inventoryHistoryTable = backend.data.resources.tables["InventoryHistory"];
const zaicoSyncJobTable = backend.data.resources.tables["ZaicoSyncJob"];
// 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: ZAICO在庫ID
// 重複作成の根本防止に使う原子的claim用テーブル
// (amplify/data/resource.tsのZaicoSourceLinkモデルコメント参照)。
// このLambda(1件同期のNext.js経路とは別のバックグラウンドworker)も
// 同じテーブルへ書き込むため、Inventory本体と同じ粒度でgrantする。
const zaicoSourceLinkTable = backend.data.resources.tables["ZaicoSourceLink"];

inventoryTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
categoryTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
locationTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
inventoryHistoryTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
zaicoSyncJobTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
zaicoSourceLinkTable.grantReadWriteData(backend.zaicoSyncWorker.resources.lambda);
backend.storage.resources.bucket.grantRead(backend.zaicoSyncWorker.resources.lambda, "inventory/*");
backend.storage.resources.bucket.grantPut(backend.zaicoSyncWorker.resources.lambda, "inventory/*");
backend.storage.resources.bucket.grantDelete(backend.zaicoSyncWorker.resources.lambda, "inventory/*");
zaicoTokenSecret.grantRead(backend.zaicoSyncWorker.resources.lambda);
backend.generateSku.resources.lambda.grantInvoke(backend.zaicoSyncWorker.resources.lambda);

backend.zaicoSyncWorker.addEnvironment("INVENTORY_TABLE_NAME", inventoryTable.tableName);
backend.zaicoSyncWorker.addEnvironment("CATEGORY_TABLE_NAME", categoryTable.tableName);
backend.zaicoSyncWorker.addEnvironment("LOCATION_TABLE_NAME", locationTable.tableName);
backend.zaicoSyncWorker.addEnvironment("INVENTORY_HISTORY_TABLE_NAME", inventoryHistoryTable.tableName);
backend.zaicoSyncWorker.addEnvironment("ZAICO_SYNC_JOB_TABLE_NAME", zaicoSyncJobTable.tableName);
backend.zaicoSyncWorker.addEnvironment("ZAICO_SOURCE_LINK_TABLE_NAME", zaicoSourceLinkTable.tableName);
backend.zaicoSyncWorker.addEnvironment("STORAGE_BUCKET_NAME", backend.storage.resources.bucket.bucketName);
backend.zaicoSyncWorker.addEnvironment("GENERATE_SKU_FUNCTION_NAME", backend.generateSku.resources.lambda.functionName);

// ─────────────────────────────────────────────────────────────────────
// データ整合性の日次監視（2026-09-04 最終フェーズ Phase B）。
// amplify/functions/integrity-monitor/resource.ts のファイル冒頭コメント参照。
//
// 権限の考え方（handler.ts の実装と対になる境界）:
//   - 監視対象のテーブルはすべて **read-only**。孤児・重複・途中状態を
//     数えるだけで、1バイトも書かない。**自動修復はしない**という方針を、
//     コードだけでなく IAM でも強制する。
//   - 書き込みを許すのは、自分の記録（基準値と実行履歴）を置く
//     IntegrityCheckLog テーブルだけ。
//
// テーブルは生CDK（skuCounterTable / priceExecutionLogTable と同じ判断）:
// 画面から直接読み書きするものではなく、GraphQL API へ露出する理由が無い。
// removalPolicy は RETAIN — 基準値が失われると「増えたかどうか」を
// 判定できなくなり、次の実行がすべて NEW に戻ってしまう。
// ─────────────────────────────────────────────────────────────────────
const integrityLogStack = backend.createStack("IntegrityCheckLogStack");
const integrityLogTable = new Table(integrityLogStack, "IntegrityCheckLogTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  // 実行履歴は1日1行。1年で自然に消えるよう handler 側が expiresAt を入れる
  // （基準値の行には入れないので消えない）。
  timeToLiveAttribute: "expiresAt",
  removalPolicy: RemovalPolicy.RETAIN,
});
integrityLogTable.grantReadWriteData(backend.integrityMonitor.resources.lambda);
backend.integrityMonitor.addEnvironment("INTEGRITY_LOG_TABLE_NAME", integrityLogTable.tableName);

// 監視対象。すべて read-only で渡す。
//
// **lib/ から import しない。** amplify/backend.ts は ampx が独自の
// ESM文脈で評価するため、lib/ の named export を解決できずデプロイが
// 落ちる。実際に job#233 が次のエラーで失敗した:
//   [SyntaxError] The requested module '../lib/integrity/tables'
//   does not provide an export named 'INTEGRITY_MONITORED_MODELS'
// ローカルの synth:check は別の解決経路を通るため通ってしまう
// （＝ここは実デプロイでしか分からない。同じ轍を踏まないこと）。
// そこでモデル名と環境変数名はここに直接書き、handler.ts が使う
// lib/integrity/tables.ts と食い違っていないことは
// scripts/verify-integrity-monitor.ts がこのファイルを読んで照合する。
const INTEGRITY_MONITOR_TABLES: Record<string, string> = {
  Inventory: "INVENTORY_TABLE_NAME",
  InventoryHistory: "INVENTORY_HISTORY_TABLE_NAME",
  ListingDraft: "LISTING_DRAFT_TABLE_NAME",
  ChannelListing: "CHANNEL_LISTING_TABLE_NAME",
  ProcessingJob: "PROCESSING_JOB_TABLE_NAME",
  ImageProcessingVersion: "IMAGE_PROCESSING_VERSION_TABLE_NAME",
  ZaicoSourceLink: "ZAICO_SOURCE_LINK_TABLE_NAME",
  MercariOrderContext: "MERCARI_ORDER_CONTEXT_TABLE_NAME",
  Conversation: "CONVERSATION_TABLE_NAME",
  Message: "MESSAGE_TABLE_NAME",
  NotificationDelivery: "NOTIFICATION_DELIVERY_TABLE_NAME",
  ZaicoSyncJob: "ZAICO_SYNC_JOB_TABLE_NAME",
};
for (const [model, envName] of Object.entries(INTEGRITY_MONITOR_TABLES)) {
  const table = backend.data.resources.tables[model];
  table.grantReadData(backend.integrityMonitor.resources.lambda);
  backend.integrityMonitor.addEnvironment(envName, table.tableName);
}
