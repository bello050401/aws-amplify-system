# BELLO 在庫管理システム — 開発メモ

このファイルは「どこに何があるか」の地図。各実装判断の詳細な理由は
該当ファイルのコメントに書いてあるので、ここでは繰り返さない。

## 全体構成

- `/inventory/*` 配下がBELLO在庫管理システム(`app/inventory/`)。
  `/admin`・`/features/*`(BASE特集ページ生成)とは別システムだが、
  Amplify Data(GraphQL API)とCognito Authは共有している。
- 認証・ロール判定: `lib/amplify/requireInventoryUser.ts`
  (ADMIN / EDITOR / VIEWER)。
- schema定義: `amplify/data/resource.ts` の「Inventory」セクション以降。
  additive-only(既存フィールド・既存データを壊す変更をしない)方針を
  一貫して守っている。

## 主要機能とその実装場所

| 機能 | UI | ロジック |
|---|---|---|
| 在庫一覧・クイック検索 | `app/inventory/(protected)/page.tsx` 他 | `lib/inventory/queries.ts` |
| 詳細検索(AND/OR・演算子) | `InventoryAdvancedSearchPanel.tsx` | `lib/inventory/advancedSearch.ts` |
| 一覧列の表示/非表示/順序/幅 | `InventoryTable.tsx` / 設定画面 | `lib/inventory/listColumns.ts` / `useInventoryListColumns.ts` |
| 在庫ID/SKU/内部DB id | — | `lib/inventory/inventoryId.ts` |
| CSV/Excel Import | `ImportWizard.tsx` | `lib/inventory/inventoryImport.ts` |
| CSV/Excel Export(ZAICO互換列) | `ExportMenu.tsx` | `lib/inventory/inventoryExport.ts` / `exportFields.ts` |
| ZAICO→BELLO同期(一方向・GETのみ) | 設定画面のZAICO同期タブ | `lib/inventory/zaicoSync.ts` / `zaicoMapping.ts` / `lib/zaico/client.ts` |
| ZAICO API TOKEN管理 | 同上 | `lib/zaico/secretStore.ts`(AWS Secrets Manager) |
| カテゴリ/保管場所/単位マスタ | 設定画面 | `lib/inventory/masters.ts` |
| 追加項目(CustomField) | 設定画面 | `lib/inventory/customFields.ts` / `customFieldSeed.ts` |
| 売上集計 | `app/inventory/(protected)/sales/page.tsx` | `lib/inventory/sales.ts` |

## 検索エンジンの設計(重要)

DynamoDBの `contains` はcase-sensitiveで、保存値をlowercase化することも
禁止されている。そのため検索は2つの経路に分かれる:

1. **サイドバーのカテゴリ/保管場所/状態のみの単純な絞り込み** —
   `lib/inventory/queries.ts` の `listInventory()`。DynamoDBのfilterへ
   実際に条件を渡す、従来通り安価なcursorページング。
2. **自由文字列検索(クイック検索)・詳細検索** —
   `listInventorySimpleSearch()` / `listInventoryAdvanced()`。
   非削除フィルタ以外は全件走査(chunked、`SEARCH_MAX_SCAN_ITEMS`で
   上限あり、既定20,000件)してから `lib/inventory/advancedSearch.ts`
   の `evaluateQuery`/`matchesQuickSearch` でcase-insensitiveに判定し、
   結果をoffsetページングで返す。

在庫件数が数万件規模を超えて増え続けた場合、この全件走査方式は徐々に
遅くなる。その規模に達したら、OpenSearch等の全文検索基盤への切り替え
を検討する必要がある(現時点では時期尚早と判断し実装していない)。

売上集計(`lib/inventory/sales.ts`)も同じ全件取得(`listAllInventory()`)
を使っており、同じ上限が適用される。

## 追加項目(CustomField)のmetadata-driven設計

`CustomFieldDefinition` を1件追加すると、コード変更なしで以下すべてに
反映される:

- 新規登録・編集フォーム(`FormFields.tsx` の `CustomFieldInput`)
- 商品詳細ページ
- 一覧の任意列(`lib/inventory/listColumns.ts` の `dynamicColumnDefsFrom`)
- 詳細検索(`lib/inventory/advancedSearch.ts` の `buildSearchFieldDefs`)
- CSV/Excel Import/Export(`inventoryImport.ts`/`inventoryExport.ts`の
  `dynamicCustomFieldDefs`/`customFieldColumns`)

「削除」は用意していない — `Inventory.customFields` という1つのJSON
blobの中に他の項目と混ざって値が入っているため、定義だけを消すと
既存データの値が宙に浮く。無効化(`isActive: false`)のみ。

## ZAICO API TOKENの管理

`lib/zaico/client.ts` の `getZaicoApiToken()` が唯一の入口:

1. AWS Secrets Manager(`lib/zaico/secretStore.ts`、設定画面から
   ADMINが読み書き)を最初に確認。
2. 無ければサーバー環境変数 `ZAICO_API_TOKEN`(`.env.local` または
   Amplify Hostingの環境変数)へフォールバック。

Amplify Hosting上のNext.js SSRコンピュートの実行ロールへSecrets
Managerの読み書き権限を付与する作業は、`defineBackend()`からは届かず
Amplify Console側の手動操作が必要(`amplify/backend.ts`のコメント
参照)。この権限が未設定でも②の環境変数だけで従来通り動作する。

**Secretリソースのライフサイクルとアプリの責務分離**(安全性レビュー
で確定した設計): `bello/zaico-api-token` というSecretリソース自体の
作成・削除は `amplify/backend.ts`(CDK/CloudFormation)だけが行う。
アプリ側(`lib/zaico/secretStore.ts`)は `GetSecretValue` /
`PutSecretValue` で値(バージョン)を読み書きするだけで、
`CreateSecret` / `DeleteSecret` は一切呼ばない — CloudFormationが
所有するリソースをアプリから物理的に作成・削除すると、次回の
`cdk diff`/deployでdrift(定義と実体の不一致)が起こり得るため。
そのためSSR実行ロールに付与すべきIAM権限も
`secretsmanager:GetSecretValue` と `PutSecretValue` の2つだけでよい。

「未設定」はSecretの値を空文字列にするのではなく、構造化JSON
`{ "configured": false }` として表現する(設定済みなら
`{ "configured": true, "token": "..." }`)。設定画面から
「ZAICO API設定を削除」した場合も、Secretの値をこの
`{ "configured": false }` へ書き戻すだけ
(`clearZaicoTokenInSecretsManager`)で、Secretリソース自体には
一切触れない。CDK側もこの同じJSON形を初期値として設定している
(`amplify/backend.ts` の `secretStringValue`)。

## Amplify Hosting / CI-CD

- `amplify.yml`(リポジトリ直下) — backendフェーズで
  `ampx pipeline-deploy` を実行し `amplify_outputs.json` を生成した後、
  frontendフェーズで `next build` を実行する標準的なAmplify Gen2 +
  Next.js SSRのbuildspec。
- `amplify_outputs.json` / `.amplify/` はgitignore対象 —
  手作業でコピーする運用にはしない。Amplify Hostingでブランチを接続
  すれば、pushのたびに`amplify.yml`の手順で自動的に生成・デプロイ
  される。
- 実際にGitHubリポジトリ・ブランチをAmplify Consoleへ接続する作業は
  GitHub OAuth + AWS Console操作が必要なため、コード側の準備のみで
  止まっている(該当セッションの完了報告のBLOCKED_BY_USER参照)。

## 既知の規模的な限界(将来の課題)

- 検索・売上集計の全件走査は既定20,000件で打ち切る
  (`SEARCH_MAX_SCAN_ITEMS`, `lib/inventory/queries.ts`)。
- CSV/Excel Importは1回最大5,000行(`IMPORT_MAX_ROWS`,
  `lib/inventory/inventoryImport.ts`)。
- どちらも「今の規模なら十分」という判断であり、事業が大きく成長した
  場合は再設計が必要になる。
