# GSI / Query / Scan 監査表(第五ラウンド §6 P0-B)

作成日: 2026-08-30。対象: リポジトリ全体で`serverDataClient.models.<Model>.list(...)`
(DynamoDB Scan相当、`filter`を渡していても物理的にはテーブル/GSI全体を
走査してからfilter条件で絞り込む)を呼んでいる全箇所と、各モデルに
`secondaryIndexes`が宣言されているかどうかの突き合わせ。

## 監査方法(再現手順)

1. `amplify/data/resource.ts`から`.secondaryIndexes(...)`を宣言している
   全モデルを`grep`で洗い出す(結果は下表「宣言済みGSI」列)。
2. `npm run synth:check`と同じCDK synthを内部で呼び出す一時スクリプトで
   実際にCloudFormationを合成し、Amplify Dataが生成した
   `model-schema.graphql`(nested stackのasset内)を実際にdumpして、
   `@index(queryField: "...")`の**生成された実際のクエリField名**を
   1件ずつ確認した(推測ではない — 例: `InventoryHistory.inventoryId`は
   `listInventoryHistoryByInventoryIdAndChangedAt`)。
3. リポジトリ全体を`grep -rn "\.list({"`で検索し、各呼び出しの
   呼び出し元・フィルタ条件・推定頻度・テーブルの増加特性(有界/無界)を
   個別に確認した。
4. 「宣言済みGSIがあるのに`.list({filter})`を使っている」箇所のうち、
   (a) 呼び出し頻度が高い(画面を開くたびに発生する)、または
   (b) テーブルが無界に増え続ける(監査ログ・チャットログ等)
   の少なくとも一方に該当するものを優先して真のQueryへ修正した。
   小規模で有界なマスタテーブル(カテゴリ・保管場所・単位・状態等、
   通常数十件規模)は、GSIが未宣言/未使用でもリスクが低いため今回は
   変更せず「許容」として記録した。

## 今回修正した箇所(5件、Query化)

| # | 呼び出し元 | モデル.フィールド | 修正前 | 修正後 | 頻度 | テーブル増加特性 |
|---|---|---|---|---|---|---|
| 1 | `lib/inventory/queries.ts` `getInventoryDetail` | `InventoryHistory.inventoryId`(+`changedAt` sort) | `.list({filter:{inventoryId:{eq}}})` | `listInventoryHistoryByInventoryIdAndChangedAt({inventoryId})` | 商品詳細ページを開くたび(最高頻度の一つ) | **無界**(追記専用の監査ログ、削除されない) |
| 2 | `lib/listing/service.ts` `getListingDraftForInventory` | `ListingDraft.inventoryId` | `.list({filter:{inventoryId:{eq}}})` | `listListingDraftByInventoryId({inventoryId})` | 商品詳細/EC出品画面を開くたび | 有界だが在庫件数に比例して増加 |
| 3 | `lib/listing/service.ts` `getChannelListing` | `ChannelListing.inventoryId` | `.list({filter:{and:[{inventoryId},{channel}]}})` | `listChannelListingByInventoryId({inventoryId})` + アプリ側で`channel`一致判定(該当商品の行は通常数件のみ) | EC出品画面のチャネル別状態表示のたび | 有界だが(在庫件数×チャネル数)に比例して増加 |
| 4 | `lib/messaging/service.ts` `listMessages` | `Message.conversationId` | `.list({filter:{conversationId:{eq}}})` | `listMessageByConversationId({conversationId})` | 会話を開くたび | **無界**(全会話ぶんのメッセージが蓄積し続ける) |
| 5 | `lib/messaging/service.ts` `recordIncomingMessage`(重複配送idempotency判定) | `Message.externalMessageId`(**新規GSI追加**) | `.list({filter:{externalMessageId:{eq}}})` | `listMessageByExternalMessageId({externalMessageId})` | Webhook受信のたび | **無界** |

新規GSI追加(#5)は`amplify/data/resource.ts`の`Message`モデルに
`index("externalMessageId")`を追加しただけの加算的変更 — 既存の
`index("conversationId")`はそのまま維持し、既存クエリ・既存データへの
影響はない。`npm run synth:check`で他の全モデル(ZaicoSyncJob/
ListingDraft/ChannelListing/MercariApiTokenSecret)の参照数が壊れて
いないことを確認済み(本ラウンドの作業ログ参照)。DynamoDBのGSIは
新規追加時に既存項目へ自動的にバックフィルされる(Amplify Data /
`Custom::AmplifyDynamoDBTable`の標準動作)ため、既存Messageレコードの
移行作業は不要。

## 副次的に発見・修正した正確性の不具合(2件、GSI監査中に発覚)

`.list({filter})`をQuery化する過程で、対象2箇所に
**ページング(nextTokenループ)が存在しない**という、パフォーマンスとは
別軸の実害あるバグを発見した(GSI化と同時に修正)。

| # | 箇所 | 不具合 | 実害 | 修正 |
|---|---|---|---|---|
| 1 | `lib/inventory/masterDedupe.ts` `reassignInventoryReferences` | カテゴリ/保管場所の統合(dedupe)時、該当categoryId/locationIdを持つInventoryを1ページ分しか取得せず再割当していなかった | 1カテゴリ/保管場所に紐づく商品がAppSyncのデフォルトpage件数を超える場合、統合後も一部の商品が古いfromIdを指したまま取り残される | GSI Query + `limit:200`のnextTokenループに変更、全件を確実に再割当 |
| 2 | `lib/inventory/masters.ts` `countInventoryReferences` | カテゴリ/保管場所/単位マスタの「使用中か」判定が同様に1ページ分しか数えていなかった | 「使用中の場合は物理削除を拒否する」安全装置が、page境界をまたぐケースで実際には使用中のmasterを誤って物理削除できてしまう可能性があった | 同様にページングループへ修正(categoryId/locationIdはGSI Query、unitはGSI未宣言のため引き続きfilter付きScanだがページングは追加) |

## 宣言済みGSI 一覧(synth実測、全モデル)

| モデル | インデックスフィールド | 生成クエリField名(実測) | 実際に使用されているか |
|---|---|---|---|
| Feature | slug | `listFeatureBySlug` | 未使用(現状`Feature.list()`のfilterなし全件取得のみ、小規模マスタなので許容) |
| Category | parentId | `listCategoryByParentId` | 未使用(全カテゴリ件数が数十〜数百規模、`listCategories`は`isActive`filterでの全件取得、許容) |
| Location | parentId | `listLocationByParentId` | 同上 |
| StatusMaster | code | `listStatusMasterByCode` | 未使用(状態マスタは数件規模、許容) |
| CustomFieldDefinition | fieldKey | `listCustomFieldDefinitionByFieldKey` | 未使用(追加項目定義は数十件規模、許容) |
| Inventory | sku / categoryId / statusId / locationId / deletedAt | `listInventoryBySku`等5種 | **一部使用**(今回#2/#3参照で新規使用開始。一覧/検索本体`fetchAllInventoryRecords`は複数条件AND/OR・updatedAt DESCソートを1箇所に統一する設計上の理由で全件取得のまま——詳細はP0-C参照) |
| InventoryHistory | inventoryId + changedAt | `listInventoryHistoryByInventoryIdAndChangedAt` | **今回使用開始**(#1) |
| ListingDraft | inventoryId | `listListingDraftByInventoryId` | **今回使用開始**(#2)。一覧(`fetchAllListingDrafts`)は概要画面向けの意図的な全件走査のまま(20,000件安全弁あり、Inventoryの`fetchAllInventoryRecords`と同じ設計方針) |
| ChannelListing | listingDraftId / inventoryId | `listChannelListingByListingDraftId` / `listChannelListingByInventoryId` | `inventoryId`側は**今回使用開始**(#3)。`listingDraftId`側は未使用箇所なし(呼び出し実績自体が無い)。一覧(`fetchAllChannelListings`)は同上の理由で全件走査のまま |
| PriceHistory | channelListingId | `listPriceHistoryByChannelListingId` | 呼び出し箇所自体が現状無し(将来の値下げ履歴表示機能用に予約) |
| Conversation | relatedInventoryId / status | `listConversationByRelatedInventoryId` / `listConversationByStatus` | 未使用(`listConversations`は全件取得——1画面に表示する会話数は運用規模的に数百件程度を想定、許容。`recordIncomingMessage`内の重複会話検索は`channel`+`externalCustomerId`の複合条件でどちらの単独GSIとも一致しないため、今回はScanのまま——低頻度のWebhook受信時のみ) |
| Message | conversationId(既存)/ externalMessageId(**新規追加**) | `listMessageByConversationId` / `listMessageByExternalMessageId` | **両方とも今回使用開始**(#4, #5) |
| ShippingRate | destinationPrefecture + rank | `listShippingRateByDestinationPrefectureAndRank` | 未使用。全3呼び出し箇所ともShippingRateテーブル自体が数十件規模の管理者用マスタで、`rank`単独条件など複合キーと一致しない条件もあるため、今回はScanのまま許容(§65のコメント通り想定規模は「数十件」) |
| AIUsageLog | task | `listAIUsageLogByTask` | 未使用(`limit:5000`で全task横断集計する用途のため、そもそも`task`で絞り込まない。5,000件上限は既存の安全弁) |
| ImageProcessingVersion | imageStorageKey | `listImageProcessingVersionByImageStorageKey` | 未使用、意図的(1画像あたりのバージョン数は数件〜十数件規模、コメントで既存踏襲の方針が明記済み——今回は変更せず) |

## 変更しなかった主要な全件走査(意図的、正当と判断)

- **`lib/inventory/queries.ts` `fetchAllInventoryRecords`** — 一覧/クイック検索
  /詳細検索/売上集計を1つの経路に統一するための意図的な全件取得
  →メモリソート→offsetページングという、2026-08-29の統合改修版で
  導入された設計(HTTP431バグ・ソート順不定バグの根本修正)。
  `SEARCH_MAX_SCAN_ITEMS=20000`という安全弁があり、現状運用規模
  (~1000件超)を大きく上回る。この設計自体を崩す変更はP0-B単独では
  行わず、P0-Cで実測ベンチマークを取り、SLO未達なら別途対応する
  (`performance/inventory-list-baseline-20260830.md`参照)。
- **`lib/listing/service.ts` `fetchAllChannelListings`/`fetchAllListingDrafts`** —
  EC出品概要画面向けの意図的な全件走査、同じ20,000件安全弁の設計方針。
- 各種マスタテーブル(Category/Location/UnitMaster/StatusMaster/
  CustomFieldDefinition/Feature/PricingRule/ShippingRate)の全件取得 —
  いずれも運用規模が数十〜数百件程度に収まることが明白な管理者設定
  テーブルであり、Scanのコストが問題になる規模ではない。
- **`lib/imageProcessing/jobService.ts` `ProcessingJob`の重複ジョブ判定** —
  既存コメントが「1商品あたり画像十数枚程度のジョブ」という想定規模と
  「件数が増えた場合はGSI追加を検討する」という将来対応方針を明記済み。
  今回のP0-B優先度基準(高頻度×無界増加)には該当しないため変更せず。

## 結論

- 高頻度×無界増加に該当した4箇所(InventoryHistory / Message×2)と、
  高頻度×有界増加の2箇所(ListingDraft / ChannelListing)を真のGSI
  Queryへ切り替えた。
- その過程で発見した、ページング欠如による2件の正確性バグ
  (`masterDedupe.ts`/`masters.ts`)も同時に修正した。
- 既に正当な理由が明記済みの全件走査(Inventory一覧本体、EC出品概要、
  各種小規模マスタ)は、今回の基準では書き直しの対象ではないと判断し、
  変更していない — 既に正しく設計されているものを作り直さない、という
  今回一貫した方針に従う。
