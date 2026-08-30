# ZAICO在庫ID重複("50666071"等)— 根本原因調査・修正記録

作成日: 2026-08-30。対応指示書: 「不具合修正・ZAICO同期重複根絶・
EC出品UI改善・画像自動加工 完全自律実装指示書」§11。

## 実際に発見した根本原因(コードを読んで特定、推測ではない)

`lib/inventory/zaicoSyncPorts.ts`の`findExistingBySourceId`(「このsourceInventoryId
を持つ既存Inventoryがあるか」を判定する関数)が、**nextTokenページングの
無い単発の`.list()`呼び出し**で判定していた:

```ts
const { data } = await serverDataClient.models.Inventory.list({
  filter: { and: [{ sourceSystem: { eq: "ZAICO" } }, { sourceInventoryId: { eq: sourceInventoryId } }] },
  ...inventoryAuthMode,
});
return data.find((d) => !d.deletedAt) ?? null;
```

`sourceSystem`/`sourceInventoryId`はInventoryのGSIに含まれておらず
(`amplify/data/resource.ts`のsecondaryIndexesに無い)、この呼び出しは
実質DynamoDB **Scan+FilterExpression**であり、単発呼び出しは
テーブル全体ではなく1回のレスポンスに収まる範囲(≈1MB分の生item)しか
走査しない。Inventoryが増えるほど、目的の行がこの走査範囲外に落ちる
確率が上がり、「既存が見つからない」と誤判定 → 新規重複作成、という
不具合を構造的に埋め込んでいた。

`amplify/functions/zaico-sync-worker/lambdaSyncPort.ts`(Lambda側の
同じ関数)も、`ExclusiveStartKey`のループ無い単発`ScanCommand`という
全く同じ形の不具合を持っていた。

この不具合自体は`lib/inventory/zaicoSyncPorts.ts`の別のコメント
(§30.7高速化仕様書、N+1問題として言及)で以前から「全件Scan問題」と
名指しされていたが、パフォーマンス上の懸念としてのみ記録され、
**正確性上の実害(重複作成)** としては修正されていなかった。

さらに§11.7が求める「DB層でのcreate二重防止」も未実装だった——
アプリ側の「検索→無ければcreate」という判定だけでは、直前の検索から
実際のcreateまでの間に別の同期(同時実行・二重クリック・resumeと
retryの重複起動)が同じsourceInventoryIdを既にcreate済みだった場合、
二重作成され得る。

## 修正内容

### 1. 新設: `ZaicoSourceLink`モデル(`amplify/data/resource.ts`)

`id`をsourceSystem+sourceInventoryIdから決定的に組み立てる
(例: `"ZAICO#50666071"`)ことで、以下2つを同時に解決する:

1. **O(1)ルックアップ**: `.get({id})`という主キー直接取得(スキャン
   不要、常に完全・即時)を`findExistingBySourceId`の一次手段にする
   ——スキャン欠落バグを構造的に再発不能にする。
2. **DB層での排他制御**: Amplifyが生成する`create`ミューテーションは
   AppSyncの標準挙動として対象`id`に条件付き書き込み
   (`attribute_not_exists`相当)を行う——同じ`id`で2回目の`create`は
   必ず失敗する。これを利用し、新規sourceInventoryIdの「claim」を
   原子的に行う(`lib/inventory/zaicoSyncPorts.ts`の
   `claimSourceLink`)。新規のDynamoDB直接操作パターンは導入しておらず、
   既存の`ZaicoSyncJob`が単一行id(`ZAICO_SYNC_JOB_SINGLETON_ID`)で
   既に使っているのと全く同じ「明示id指定create」パターンの応用。

### 2. `syncOneZaicoItem`(`lib/inventory/zaicoSyncEngine.ts`)の再構成

新規作成と判定した時点で、実際にInventoryを作る前にこの
sourceInventoryIdをDB層で原子的にclaimする。claimに失敗した場合
(=自分より先に誰かが本当にこのsourceInventoryIdを保持している)は
新規作成をやめ、その既存レコードへのupdate経路へ安全に切り替える
——これによりcreate自体は決して2回実行されない。createInventory自体が
失敗した場合はclaimしたリンクを解放し(補償操作)、次回の再試行を
妨げない。

Next.js側(`zaicoSyncPorts.ts`)・Lambda側(`lambdaSyncPort.ts`、生
DynamoDB `ConditionExpression: "attribute_not_exists(id)"`)の両方の
`ZaicoSyncPort`実装がこの契約を満たす。

### 3. 既存重複の全件監査・安全な整理(`lib/inventory/zaicoDuplicateAudit.ts`)

- `runZaicoDuplicateAudit()`: 非削除の全Inventoryを完全走査
  (nextTokenを必ずループ)し、sourceInventoryIdでグルーピング、2件
  以上のグループを重複として報告する。総Inventory件数・ZAICO連携
  件数・重複グループ数・影響レコード数を返す(§11.5必須項目)。
- `mergeZaicoDuplicate(sourceInventoryId, canonicalInventoryId)`:
  実行直前に監査を再取得して再検証したうえで、関連6モデル
  (InventoryHistory/ListingDraft/ChannelListing/ProcessingJob/
  ImageProcessingVersion/Conversation)の参照を正規レコードへ
  付け替え(削除ではなく更新——関連データは1件も失われない)、正規
  レコードに画像が無い場合のみ重複側の画像を引き継ぎ、統合履歴を
  記録してから重複レコードを削除する。ADMINが監査結果を見てグループ
  ごとに個別実行する(「全部まとめて自動統合」ボタンは作らない)。
- 設定画面「ZAICO」タブに`ZaicoDuplicateAuditPanel`として設置。

### 4. 既存レコードへのリンク移行(`lib/inventory/zaicoSourceLinkBackfill.ts`)

`ZaicoSourceLink`は今回新設したモデルなので、既存のZAICO連携
レコードには一切リンクが無い。`thumbnailBackfill.ts`/
`listingPartitionBackfill.ts`と同じbounded・idempotent・resumable
設計のバックフィルを新設——この過程自体が「既にリンク済みの
sourceInventoryIdへ別レコードがリンクを試みて失敗する」という形で
既存の重複を検出する(全件監査の実質的な前段)。

## テスト

`scripts/verify-zaico-sync.ts`に6件の新規シナリオを追加(既存48件+
新規23件=71件、全green):
- `claimSourceLink`の原子性(1回目成功・2回目失敗・release後の再claim)。
- **実際の不具合の再現テスト**: `findExistingBySourceId`を常にnullへ
  固定した状態(スキャン欠落バグの最悪ケースを直接再現)でも、
  `claimSourceLink`のDB層排他制御だけで2件目のcreateが防げることを
  検証(単発同期経路・バッチ/resume経路の両方)。
- number/string境界(`id: 6001` vs `id: "6001"`)が同一sourceとして
  扱われる回帰確認。
- 実例(ZAICO在庫ID"50666071"相当)を5回連続同期してもInventoryが
  1件のまま増えないことの確認。
- createInventory失敗時にclaimが解放され、次の再試行が正しく成功する
  ことの確認(§11.8同時実行/retry)。

`scripts/verify-zaico-duplicate-audit.ts`(新規、14件)——グルーピング・
正規候補選定(最古優先)・件数集計の純粋ロジックを検証。

## この修正の範囲・正直な残課題

- **根治(将来の新規重複を防ぐ仕組み)は完成・ローカル検証済み**
  (`LOCAL_VERIFIED`)——tsc/lint/synth:check/全11 verify:*スイート
  (383件)/production buildが全てgreen。
- **実データに対する監査・統合の実行は未実施**(`BLOCKED_BY_USER`)
  ——AWS認証情報が無効なため、実際に"50666071"を含む実データへ
  リンク移行・監査・統合を実行して確認することができない
  (`docs/aws-staging-reverify-20260830.md`参照)。ツール自体は
  ADMINが設定画面から実行できる状態で用意されている。
- **実DynamoDBの条件付き書き込みの実挙動そのものは未検証** ——
  `claimSourceLink`が依拠するAppSyncの標準的なcreate条件付き書き込み
  挙動は、AWS公式ドキュメントに基づく一般的な仕様理解であり、この
  ラウンドでは実AWS環境に対して直接確認できていない。既存の
  `ZaicoSyncJob`単一行idパターンが同じ前提の上で既に機能している
  ことが唯一の間接的な裏付け。
