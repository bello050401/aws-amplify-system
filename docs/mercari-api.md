# メルカリShops API 調査メモ

最終更新: 2026-08-26 (Phase 1 開始時点)

## 0. このドキュメントの位置づけと重要な制約

開発着手前の指示（指示書 65〜66項）に従い、実装前にメルカリShops公式APIドキュメント
(`https://api.mercari-shops.com/docs/index.html`) および GraphQL Schema
(introspection) を確認しようとしましたが、**本開発環境（サンドボックス）のネットワーク
Egressポリシーにより `api.mercari-shops.com` / `engineering.mercari.com` /
`support.mercari-shops.com` など mercari-shops 関連ドメインへのアクセスが
ブロックされており、直接確認できませんでした**（`WebFetch` は
`EGRESS_BLOCKED` エラーを返しました）。

さらに調査の過程で、メルカリShops APIのSandbox GraphQL Schema（Apollo Sandbox の
"Schema" → "Raw" 経由でのダウンロード）自体が、**事前登録されたIPアドレスからのみ
アクセス可能**という制約があることも判明しました（一般公開のIntrospectionではない）。
つまりこの制約は開発サンドボックス固有の問題ではなく、メルカリShops API連携の申請・
契約を行い、IP登録を済ませた開発者本人でなければSchemaを直接確認できない、という
仕様上の制約です。

**したがって、本ドキュメントに記載する GraphQL の型名・フィールド名・enum値は、**
**(a) 指示書に記載された情報、(b) 検索で得られた二次情報（エンジニアブログの見出し等）**
**を基にした現時点のベストエフォートであり、`[UNVERIFIED]` と明記した箇所は**
**実際のSchemaで必ず再確認が必要です。**

### 実装方針（Schema差異への対応）

1. GraphQLの型は可能な限り「ハードコードした型定義」ではなく、**codegen**
   （`graphql-codegen`）で生成する前提の構成にしています。
   `npm run mercari:codegen` を、`.env` に有効な `MERCARI_API_ACCESS_TOKEN` と
   ネットワーク到達性（IP許可済み）がある環境で実行すれば、実際のSchemaから
   TypeScript型を自動生成できます（`src/integrations/mercari-shops/types/generated/`
   に出力）。
2. Enum値・カテゴリー・ブランド・配送方法・発送日数などUIに出す選択肢は、
   **可能な限りAPIから動的取得**し（`productCategories` / `productBrands` /
   スキーマ上の enum values を取得するクエリ）、DBにキャッシュする設計にしています。
   ハードコードが必要な最小限の値（`ProductCondition` の日本語ラベル対応表など）は
   `src/integrations/mercari-shops/mapper/` 配下の1ファイルに集約し、Schema変更時に
   1箇所の修正で追随できるようにしています。
3. Sandbox接続が実際に確立でき、`createProduct` の実成功が確認できるまでは、
   Phase 2（Production切替）へ進みません（指示書 55, 62項）。

---

## 1. エンドポイント・認証

| 項目 | 値 |
|---|---|
| Production Endpoint | `https://api.mercari-shops.com/v1/graphql` |
| Sandbox Endpoint | `https://api.mercari-shops-sandbox.com/v1/graphql` |
| プロトコル | GraphQL over HTTPS (単一エンドポイント) |
| 認証方式 | `Authorization: Bearer <PERSONAL_API_ACCESS_TOKEN>` |
| 環境切替 | `.env` の `MERCARI_ENV=sandbox` / `production` |

エンドポイントURLはコード中に散在させず、
`src/integrations/mercari-shops/endpoints.ts` の1箇所でのみ定義しています
（指示書33項）。

## 2. クライアント構成

```
src/integrations/mercari-shops/
  MercariShopsClient.ts   … fetchベースの薄いGraphQLクライアント（timeout, retry, rate limit対応）
  endpoints.ts            … sandbox/production エンドポイント定義
  queries/                … 取得系ドキュメント（products, categories, brands, shippingOptions）
  mutations/               … 更新系ドキュメント（createProduct, updateProduct, createProductShippingConfiguration）
  types/                   … API入出力の型（手動定義。将来 codegen 生成物に置換）
  mapper/                  … 内部ドメインモデル ⇔ Mercari API 型の変換（enum変換含む）
```

Reactコンポーネントから直接GraphQLを呼び出さず、必ず
`domain/adapters/MercariShopsAdapter` 経由で呼び出します（指示書34項）。

## 3. 商品登録に必要な主なQuery/Mutation `[UNVERIFIED: 実Schemaで要確認]`

- `query productCategories` … カテゴリー階層を取得。末端カテゴリー判定のため
  `children` の有無を利用する想定。
- `query productBrands(query: String)` … ブランド検索。
- `query shippingFromStates` / スキーマ上の enum `ShippingFromState` … 配送元都道府県。
- `mutation createProduct(input: CreateProductInput!)` … 商品作成。
- `mutation updateProduct(input: UpdateProductInput!)` … 商品更新（Phase 2）。
- `mutation createProductShippingConfiguration(input: ...)` … 配送設定作成
  （2026年6月以降提供、指示書27, 29項）。
- `query product(id: ID!)` / `query products(...)` … 商品同期用（Phase 2、カーソル
  ページネーション想定）。

## 4. CreateProductInput `[UNVERIFIED]` 想定フィールド

指示書36項に基づく最低限の想定。実装は `types/CreateProductInput.ts` に集約し、
Schema確定後はここだけを更新すれば良い構造にしています。

```ts
interface CreateProductInput {
  name: string;               // 文字数上限は要確認。暫定 40文字と仮定し、
                               // 定数化 (MERCARI_LIMITS.NAME_MAX) して1箇所で管理。
  description: string;        // 指示書に基づき暫定 3000文字上限。
  price: number;               // 整数、日本円。
  categoryId: string;          // 必須。末端カテゴリーのみ。
  brandId?: string | null;     // 任意。
  condition: ProductCondition; // enum。UIでは日本語ラベルに変換。
  images: { url: string; sortOrder: number }[];
  shippingPayer: ShippingPayer;
  shippingMethod: ShippingMethod;
  shippingDuration: ShippingDuration;
  shippingFromStateId: string;
  shippingConfigurationId?: string | null;
  status: ProductApiStatus;    // 下書き/公開 等
  variants: ProductVariantInput[];
  channelListingScope?: unknown; // 用途不明、要確認
}
```

文字数上限は `MERCARI_LIMITS` (`src/integrations/mercari-shops/types/limits.ts`)
に集約し、UIの「現在 X / 上限Y文字」表示はすべてこの定数を参照します（指示書8, 9項）。
**Sandbox接続確立後、最初に行うべき検証タスクの1つとして、`name`/`description` の
実際の上限値をSchemaの `String` へのカスタムディレクティブ、またはエラーメッセージ
から確認し、この定数を実測値に更新してください。**

## 5. Enum一覧 `[UNVERIFIED]`

以下は指示書に記載された名称・想定に基づく暫定値です。UIには絶対に生のenum値を
出さず、`mapper/` 内の対応表を介して日本語ラベルに変換しています。Schema確認後は
対応表の中身だけを更新してください（UIコンポーネント側の変更は不要な設計）。

- `ProductCondition`: 新品・未使用〜全体的に状態が悪い、の6段階（指示書13項）。
- `ShippingPayer`: 出品者負担 / 購入者負担。
- `ShippingMethod`: Schemaから動的取得を基本とし、取得失敗時のみ最小限の
  フォールバック候補を表示（指示書26項）。
- `ShippingDuration`: 1〜2日 / 2〜3日 / 4〜7日 / 8日以上（指示書25項、暫定）。
- Product Status（API側）: 内部ステータス(DRAFT/READY/PUBLISHED/CLOSED/SOLD_OUT/ERROR)
  と直接一致させず、`MercariListing.mercariStatus` に生値を保持し、
  `Product.internalStatus` は自社ロジックで管理（指示書31, 58項）。

## 6. レート制限・エラー処理

検索調査により「ショップ単位で1時間あたり最大10,000ポイント」という情報が
得られましたが `[UNVERIFIED]`。`MercariShopsClient` は以下を実装しています。

- リクエストタイムアウト（デフォルト15秒、`.env`で調整可）。
- GraphQLエラー / HTTPエラーを握り潰さず、`IntegrationLog` に記録（指示書39, 40項）。
- 429 / 5xx 系エラー時は指数バックオフで最大 `MERCARI_MAX_RETRIES`（デフォルト3回）
  までリトライ。無限リトライは行わない（指示書47項）。
- Personal Access Tokenはログ・エラーメッセージ・DBのいずれにも平文で残さない
  （`lib/crypto.ts` でAES-256-GCM暗号化してDB保存、指示書32, 39, 56項）。

## 7. Sandbox接続確認チェックリスト（Phase 1完了条件の一部）

- [ ] `.env` に Sandbox用 Personal API Access Token を設定
- [ ] `/settings/mercari` からトークン登録・暗号化保存できること
- [ ] `productCategories` が取得でき、末端カテゴリーのみ選択可能なUIになっていること
- [ ] `productBrands` 検索が動作すること
- [ ] `createProduct` がSandboxで成功し、`product.id` を取得・DB保存できること
- [ ] 上記完了後、`name`/`description` 文字数上限など `[UNVERIFIED]` 項目を実測値に更新

この一覧が全てチェックできた時点で Phase 1 完了とし、Phase 2（Production切替・
updateProduct等）に着手します（指示書55, 62, 63項）。
