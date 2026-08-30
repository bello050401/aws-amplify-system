# Inventory一覧 真のサーバー側cursor pagination — 設計・移行記録(第六ラウンド P0-5)

作成日: 2026-08-30。関連: `amplify/data/resource.ts`のInventoryモデル
コメント、`lib/inventory/inventoryCursorList.ts`、
`lib/inventory/listingPartitionBackfill.ts`、
`lib/inventory/thumbnailBackfill.ts`の既知不具合コメント。

## 背景 — 何を直そうとしたか

`BELLO統合改修 master指示書(2026-08-29統合改修版) §8/§9`で、Inventory
一覧は「非削除の全件をDynamoDBから取得(`fetchAllInventoryRecords`、
chunkedページング) → アプリ側で`updatedAt DESC`ソート → 配列をoffsetで
slice」という設計へ統一された(`lib/inventory/queries.ts`)。この設計は
テキスト検索・詳細検索(AND/OR混在条件はDynamoDBの`FilterExpression`
単体で表現できないため、本質的に全件走査+アプリ側判定が必要)には理に
かなっているが、**検索語なし・サイドバーのカテゴリ/保管場所/状態
フィルタのみの単純な一覧表示**にとっては、DynamoDBレベルでソート済みの
結果を直接取得できるはずなのに毎回全件走査している点で、件数が今後
大きく増えた場合にスケールしない根本的な非効率が残っていた
(`SEARCH_MAX_SCAN_ITEMS=20000`が安全弁として存在するのはこのため)。

第六ラウンドの指示書(BELLO統合業務OS第六ラウンド再改訂完全版)P0-5は
これを「Root-fix」(根本修正)することを求めている。

## 採った設計 — 定数パーティションキーGSI

DynamoDBには「テーブル全体をあるソートキーで並べ替えたQuery」を行う
標準的な方法が無い(Queryは常にパーティションキーの一致が必要)。この
制約を回避する定石が、**値が常に一定のパーティションキー**を持つGSIを
作ることである:

```ts
listingPartition: a.string(),   // 常に"ACTIVE"固定値
listUpdatedAt: a.datetime(),    // 明示フィールド(下記参照)
```
```ts
.secondaryIndexes((index) => [
  // ...既存のindex...
  index("listingPartition").sortKeys(["listUpdatedAt"]),
])
```

`listingPartition`に常に同じ値("ACTIVE")を入れることで、このGSIへの
Query(`listingPartition = "ACTIVE"`という一致条件)は実質「テーブル
全体」を対象にしつつ、DynamoDB自身が`listUpdatedAt`でソート済みの結果を
返す——真のQueryであり、Scanでも「全件取得してアプリ側でソート」でも
ない。

### なぜAmplifyの自動`updatedAt`をそのままソートキーに使えないか

先行するラウンドで`AIUsageLog`モデルにこの制約が既にコメントとして
記録されていた: **Amplifyの自動管理タイムスタンプ(`createdAt`/
`updatedAt`)はGSIのsortKeyとして使えない**(明示的なmodelフィールドしか
使えない、synth時に実際にエラーで確認済み)。このため、新たに明示的な
`listUpdatedAt: a.datetime()`フィールドを追加し、書き込み経路側で
手動でセットする設計にした(下記「書き込み経路」参照)。

### なぜ`listingPartition`は常に`"ACTIVE"`で問題ないか

Inventoryの削除は**物理削除のみ**であることを確認済み
(`grep -rn "Inventory.delete(\|hardDelete\|物理削除"`が
`app/actions/inventory.ts`の`deleteInventory`一箇所のみを返した——
`deletedAt`をセットするソフトデリートの書き込み経路はコードベース上に
一切存在しない、`deletedAt`は読み取り時に`attributeExists: false`で
フィルタされているだけの、将来のソフトデリート機能に備えた予約
フィールドという扱いになっている)。したがって「削除されたら
`listingPartition`をパーティションから外す」といった特別な遷移ロジックは
不要——物理削除されたレコードはテーブル自体から消えるため、GSIからも
自動的に消える。

## 書き込み経路 — `listUpdatedAt`を設定した箇所・意図的に設定しなかった箇所

| ファイル | 関数 | 種別 | 対応 |
|---|---|---|---|
| `app/actions/inventory.ts` | `createInventory` | create | `listingPartition="ACTIVE"` + `listUpdatedAt=now` |
| `app/actions/inventory.ts` | `updateInventory` | update | `listUpdatedAt=now` |
| `lib/inventory/inventoryImport.ts` | `executeImportRows`(create分岐) | create | `listingPartition="ACTIVE"` + `listUpdatedAt=now` |
| `lib/inventory/inventoryImport.ts` | `executeImportRows`(update分岐) | update | `listUpdatedAt=now` |
| `lib/inventory/masterDedupe.ts` | `reassignInventoryReferences`(Category/Location両方) | update | `listUpdatedAt=now` |
| `lib/inventory/zaicoSyncPorts.ts` | `createServerSyncPort().createInventory` | create | `listingPartition="ACTIVE"` + `listUpdatedAt=now` |
| `lib/inventory/zaicoSyncPorts.ts` | `createServerSyncPort().updateInventory` | update | `listUpdatedAt=now`(呼び出し元`zaicoSyncEngine.ts`が実差分ありの場合のみ呼ぶ——unchanged fast-pathはここに到達しない、実装を読んで確認済み) |
| `app/actions/inventoryBulkEdit.ts` | `bulkUpdateInventoryListFields` | update | `listUpdatedAt=now` |
| `amplify/functions/zaico-sync-worker/lambdaSyncPort.ts` | `createInventory`/`updateInventory`(生DynamoDB PutItem/UpdateItem) | create/update | 同上を手動で設定(この経路は`serverDataClient`を経由しないため) |
| **`lib/inventory/thumbnailBackfill.ts`** | `advanceThumbnailBackfill` | update | **意図的に設定しない**(下記参照) |

### `thumbnailBackfill.ts`を意図的に除外した理由(既知バグの根治)

`thumbnailBackfill.ts`は既に、自分自身の`.update()`呼び出しが
サムネイルキー(ユーザーには見えない内部フィールド)しか書き込んで
いないにもかかわらず、Amplifyの自動管理`updatedAt`を無条件に「今」へ
進めてしまい、一覧のデフォルトソート(`updatedAt DESC`)で対象レコードが
何も変わっていないのに最上位へ浮上してしまう、という既知の実害を
コメントで記録していた(同ファイルの冒頭コメント参照、意図的に見送ると
明記されていた)。

新設の`listUpdatedAt`はAmplify自動`updatedAt`とは完全に独立した明示
フィールドであるため、この書き込みで一切触れなければ、既存の
`listUpdatedAt`値がそのまま保たれる——つまり、この新GSIへ切り替える
ことは、`旧updatedAt`ベースの一覧ソートが抱えていたこの既知バグを
**同時に根治する**。

## 一度きりの移行(バックフィル)

`listingPartition`/`listUpdatedAt`は今回新設したフィールドなので、この
ラウンドより前に作成された既存レコードには一切値が入っておらず、この
GSIには現れない。`lib/inventory/listingPartitionBackfill.ts`
(+ `app/actions/listingPartitionBackfill.ts` + 設定画面「画像」タブ内の
`ListingPartitionBackfillPanel`)が、`thumbnailBackfill.ts`と全く同じ
bounded・idempotent・resumable設計(永続ジョブ/ロック無し、1回の呼び
出しは最大50件、既に移行済みのレコードはスキップ)でこれを解決する。

**並び順を壊さないための設計判断**: 新規に`listUpdatedAt`を設定する際、
値は「今」ではなくそのレコードの**既存の`updatedAt`**(Amplify自動管理
タイムスタンプ、バックフィル実行より前の最終更新時刻)をそのまま複製
する。バックフィル自体がレコードを一覧の先頭へ押し上げることはなく、
新GSIの並び順は旧`updatedAt DESC`の並び順を初期状態として正しく
引き継ぐ。

## 新設した`lib/inventory/inventoryCursorList.ts` — 提供する機能と制約

- `listInventoryByListingPartitionCursor(filters, cursorState, limit)`:
  新GSIへの真のQuery。`categoryIds`/`locationId`/`statusId`フィルタ
  (DynamoDBの`FilterExpression`として、Queryの一部——Scanではない)に
  対応。テキスト検索(`q`)・詳細検索(AND/OR混在条件)は対象外——それらは
  本質的に全件走査+アプリ側判定が必要であり続けるため、引き続き
  `lib/inventory/queries.ts`の`listInventorySimpleSearch`/
  `listInventoryAdvanced`が正しい実装であり続ける。
- Bounded 2-tokenカーソル(`CursorPaginationState { cur, prev }`)+
  `encodeCursorState`/`decodeCursorState`(URL境界を越える単一の不透明
  文字列、Base64 URLセーフ)。旧HTTP 431実障害(全訪問済みページの
  `nextToken`を無制限にURLへ積み上げていた設計)の再発を、状態のサイズを
  常に2トークンに固定することで構造的に防ぐ。
- 純粋ロジック(状態遷移・encode/decode)は`scripts/verify-inventory-cursor.ts`
  (`npm run verify:inventory-cursor`)で20件のアサーションを検証済み。
- 実際のDynamoDB Query呼び出し自体は他のverify-*.tsと同じ方針でAWS
  接続を要するため対象外——`npx tsc --noEmit`が通ったことで、
  `listInventoryByListingPartitionAndListUpdatedAt`という生成された
  クライアントメソッド名・入出力の型シグネチャが実際にAmplifyの型
  生成結果と一致していることは検証済み(型がテスト用に手で合わせた
  ものではなく、`amplify/data/resource.ts`のスキーマ定義から実際に
  生成された`Schema`型そのものに対してコンパイルが通っている)。

## この経路がまだ`listInventory`のデフォルトに切り替わっていない理由(正直な記録)

1. **バックフィル未実行**: 実データに対して`ListingPartitionBackfillPanel`
   を実際に実行し、実機で検証した実績がまだ無い(AWS認証情報が無く
   実デプロイができないため——P0-6参照)。切り替えた場合、バックフィル
   未実行の既存レコードが新GSIの一覧から一切見えなくなるという重大な
   回帰リスクがある。
2. **総件数(total)を返さない**: cursor pagination方式は「currentトーク
   ンから次ページを1回のQueryで取得する」方式であり、offset方式のよ
   うな「X件中Y〜Z件目」という総件数表示に必要な"全件のうち何番目か"
   という概念を持たない。真に安価な総件数(DynamoDBの`Select: COUNT`)を
   取得するには、Next.jsサーバーの現在の権限モデル(Amplify Data/
   AppSync経由のみ、生DynamoDB SDKアクセス無し——`thumbnailBackfill.ts`
   の監査コメントで「生DynamoDBアクセスは実環境未検証のリスクがあり
   見送り」と既に判断済み)を変える新規インフラ(カスタムQueryリゾルバ
   等)が必要で、これも実AWS環境での検証手段が無い今回のラウンドでは
   追加しない。
3. **「前へ」が1段分しか戻れない**: bounded 2-tokenカーソル設計は、
   「直前の1ページ分だけ戻れる」("次へ"を押す前の状態に戻す取り消し
   操作)までしかサポートしない——ページ番号を指定した任意ジャンプや、
   2ページ以上前への「戻る」は対象外。DynamoDBのcursorは本質的に前方
   参照専用のopaqueトークンであり、AppSyncの内部トークン形式に依存した
   Relay形式の双方向カーソル(GitHub APIのような`startCursor`/
   `endCursor`)を自前で構築するのは、AppSync側の内部エンコード形式が
   公開仕様ではなく実AWS環境での検証手段も無い今回は見送った。

上記3点は「総件数表示」と「任意ページジャンプ」を諦めて無限スクロール
/シンプルな次へ・前へUIへ移行するかどうか、というUI設計判断を伴う——
自律的なエンジニアリング判断の範囲を超えると判断し、今回は「基盤(GSI
+新関数)を実機検証可能な形で用意する」ところまでとした。

## 移行ランブック(将来、実AWS環境で切り替える場合の手順)

1. Staging環境へこのラウンドのスキーマ変更をデプロイする(P0-6参照、
   今回のセッションでは未実施)。
2. ADMINが設定画面「画像」タブの「一覧インデックス移行」パネルを実行し、
   既存の全Inventoryレコードへ`listingPartition`/`listUpdatedAt`を
   バックフィルする。`scanned`と`backfilled`の件数が一致し`完了`表示に
   なるまで実行する(件数が多い場合は複数回に分けて「続きから実行」)。
3. バックフィル完了後、実データに対し新旧2つの一覧取得経路
   (`listInventory` vs `listInventoryByListingPartitionCursor`)を
   同じフィルタ条件で実行し、返る商品ID集合が一致することを確認する
   (差分が無いことが、バックフィルが本当に全件へ行き渡ったことの
   実質的な検証になる)。
4. UI側で「総件数表示」「任意ページジャンプ」をどこまで維持するか
   (本ドキュメント「まだ切り替わっていない理由」2./3.)を製品判断として
   決定したうえで、`app/inventory/(protected)/page.tsx`の呼び出しを
   `listInventoryByListingPartitionCursor`へ切り替える。
5. 切り替え後もテキスト検索・詳細検索は引き続き既存の全件走査経路の
   ままでよい(本質的な制約であり、この移行で変える対象ではない)。

## §177 アクセスパターン監査表(在庫一覧の検索条件別)

| 検索条件の種類 | 実装 | DynamoDBアクセス | 備考 |
|---|---|---|---|
| 単純一覧(検索語なし、カテゴリ/保管場所/状態フィルタのみ) | `lib/inventory/queries.ts`の`listInventory`(現行デフォルト) | 全件走査(`fetchAllInventoryRecords`、chunked)+アプリ側ソート+offset slice | **今回のP0-5で真のGSI Query版(`inventoryCursorList.ts`)を用意したが、上記理由により未切り替え** |
| 単純一覧・GSI版(未切替・新規基盤) | `lib/inventory/inventoryCursorList.ts`の`listInventoryByListingPartitionCursor` | 真のQuery(`listingPartition`定数パーティション+`listUpdatedAt`ソート、DynamoDBレベルでソート済み) | カテゴリ/保管場所/状態は`FilterExpression`として付加(Queryの一部、Scanではない) |
| クイック検索(商品検索ボックス`q`) | `listInventorySimpleSearch` | 全件走査+アプリ側case-insensitive部分一致判定+offset slice | DynamoDBの`contains`はcase-sensitiveであり要件を満たせないため本質的に全件走査+アプリ側判定が必要(既存コメント参照) |
| 詳細検索(AND/OR混在条件) | `listInventoryAdvanced` | 全件走査+アプリ側`evaluateQuery`判定+offset slice | AND/OR混在条件はDynamoDBの`FilterExpression`単体で表現できないため本質的に全件走査が必要 |
| カテゴリ統合(masterDedupe) | `reassignInventoryReferences` | 真のQuery(`listInventoryByCategoryId`/`listInventoryByLocationId`、既存GSI) | 第五ラウンドP0-Bで既にScanからQueryへ修正済み(このラウンドでの変更無し、`listUpdatedAt`更新のみ追加) |
| マスタ使用件数カウント(masters.ts) | `listInventoryByCategoryId`/`listInventoryByLocationId` | 真のQuery(既存GSI) | 変更無し |
| 売上集計・エクスポート等、フィルタ無し全件が必要な処理 | `listAllInventory`/`fetchAllForExport` | 全件走査(chunked) | 用途自体が「全件」を要求するため、Query化の余地は無い(本質的に全件が必要) |
