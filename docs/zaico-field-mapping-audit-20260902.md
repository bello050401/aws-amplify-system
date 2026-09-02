# ZAICO → BELLO 全項目マッピング監査(2026-09-02)

対象ブランチ: `claude/inventory-management-system-5vbvc7`(Staging)
main / Production: **一切変更していない**

すべての数値は ZAICO API の実レスポンスと Staging の実データに対する
実測値。推測値は含まない。再計測は `npm run audit:zaico-fields`。

---

## 0. 結論を先に

**販売予定価格は「取得できていなかった」のではなく、「取得しているのに
捨てていた」。** ZAICO は `☆販売予定価格（送料別大原記載）` という名前で
値を返しており、BELLO には `Inventory.plannedSalePrice` という専用列が
最初から存在し、CSV入出力も同じラベルで対応していた。欠けていたのは
`lib/inventory/zaicoMapping.ts` の対応表の1行だけだった。

同じ調べ方をすると、**同種の欠落が他に14項目**見つかった。いずれも
BELLO側に受け皿(列またはCustomFieldDefinition)が既にあるのに、
対応表に載っていなかったもの。

さらに、まったく別種の欠落として **在庫数量が全件0** だった。

---

## 1. 数量が全件0だった件

### 実測

| 対象 | 値 |
|---|---|
| Inventory の総数 | 5,313 |
| `quantity` が 0 の行 | **5,313(全件)** |
| 0 以外の値を持つ行 | **0件** |
| 同じ商品の ZAICO 側の値 | `"2.0"` / `"1.0"` |

### 原因

ZAICO API は数量を **文字列** で返す。

```
GET /inventories/73116696 → { "quantity": "2.0", ... }
```

`lib/inventory/zaicoMapping.ts` の `mapZaicoCoreFields` が

```ts
quantity: typeof item.quantity === "number" ? item.quantity : null
```

と判定していたため常に `null` になり、`zaicoSyncEngine` 側の
`quantity: core.quantity ?? 0`(新規)/ `: undefined`(更新)と合わさって、
**新規作成時に0が入り、以後の同期で二度と更新されない**状態だった。

型宣言 `ZaicoInventory.quantity` も `number | null` と書かれており、
実際のレスポンスと食い違っていた。

### 修正

`parseZaicoQuantity` を新設。文字列を数値化し、

- 数値化できない値は **0にせず** `null` + 警告
- 小数は切り捨て + 警告(BELLOの `quantity` は integer 列)

型宣言も実レスポンスに合わせた(`number | string | null`)。

---

## 2. 販売予定価格(指示書§11の本丸)

### End-to-End の追跡結果

| 段階 | 状態 |
|---|---|
| ZAICO API raw | `"☆販売予定価格（送料別大原記載）" = "24800"` ✅ |
| parser (`mapZaicoOptionalAttributes`) | **ここで落ちていた** ❌ 対応表に項目が無く unmapped |
| normalization | 到達せず |
| DynamoDB `Inventory.plannedSalePrice` | 5,313件中 **2件のみ**(CSV/手入力由来) |
| server query (`toExtendedFields`) | 実装済み ✅ |
| UI(一覧列・詳細・編集フォーム) | 実装済み ✅ |
| EC出品の価格計算 | `salePrice ?? plannedSalePrice` で参照済み ✅ |
| 送料込み参考価格 | `plannedSalePrice` が無いと「販売予定金額が未入力です」で表示不可 ❌ |

つまり **parser の1段だけが欠けていて、その先の全部は最初から用意されて
いた**。「UIに出ていないからUIへ足す」では直らないし、足す必要も無かった。

### 名称の整理(§14)

| 名前 | 意味 | 扱い |
|---|---|---|
| `plannedSalePrice` | 販売予定価格(送料別)。ZAICO「☆販売予定価格（送料別大原記載）」が正本 | **canonical** |
| `salePrice` | 販売価格(成約後の実売価格)。ZAICO「⚫︎販売価格」 | 別概念。統合しない |
| `firstMarkdownPrice` 他 | 値下げ計画額(30/60/90日) | 別概念 |

`salePrice` と `plannedSalePrice` は **意味が違う**(成約実績 vs 予定)。
schema のコメントにも元から区別が書かれている。統合していない。

参照側は `salePrice ?? plannedSalePrice`(成約価格があればそちら、
無ければ予定価格)で一貫しており、変更していない。

---

## 3. 完全な field inventory

`npm run audit:zaico-fields` が ZAICO の実レスポンス1,000件を数えた結果。
「値あり件数 / 出現件数」と、BELLO側の保存先。

### 3.1 core フィールド

| ZAICO field | 出現率 | BELLO保存先 | 状態 |
|---|---|---|---|
| `id` | 100% | `sourceInventoryId` | A |
| `title` | 99.7% | `name` | A |
| `quantity` | 88.4% | `quantity` | **E → 修正済み**(文字列を数値化していなかった) |
| `unit` | 2.9% | `unit` | A |
| `category` | 100% | Category マスタ | A |
| `place` | 98.4% | Location マスタ | A |
| `etc` | 42.5% | `note` | A |
| `code` | 100% | `barcode` | A |
| `item_image.url` | 100% | S3へ取り込み | A |
| `categories` | 100% | — | F(`category` と重複) |
| `state` | 16.5% | — | F(値が定型でなく、BELLOのStatusMasterと対応が取れない) |
| `created_at` / `updated_at` / `update_date` | 100% | — | F(BELLO側が独自にタイムスタンプを持つ) |
| `create_user_name` / `update_user_name` | 100% | — | F |
| `user_group` | 100% | — | F |
| `group_tag` | — | — | F |
| `stocktake_attributes` | 100% | — | F(棚卸機能を使っていない) |
| `is_quantity_auto_conversion_by_unit` 他 | 100% | — | F |

### 3.2 optional_attributes

| ZAICO field | 値あり | BELLO保存先 | 分類 |
|---|---|---|---|
| ⚫︎購入価格 | 100.0% | `purchasePrice` | A |
| ⚫︎市場 | 89.6% | `market` | A |
| ⚫︎販売終了日 | 88.0% | `saleEndDate` | A |
| ⚫︎商品ID | 88.0% | `externalProductId` | A |
| ⚫︎販売価格 | 87.8% | `salePrice` | A |
| ⚫︎販売開始日 | 75.4% | `saleStartDate` | A |
| ⚫︎売却時配送料金 | 66.7% | `customFields.saleShippingCost` | **B → 修正済み** |
| ⚫︎販売手数料 | 66.7% | `saleCommission` | A |
| ⚫︎手元に入ってきた売上金 | 65.2% | `customFields.netSaleProceeds` | **B → 修正済み** |
| ⚫︎相手氏名 | 58.0% | `counterpartyName` | A |
| ⚪︎幅（cm） | 53.5% | `width` | A |
| 新品or中古 | 53.3% | `customFields.newOrUsed` | **B → 修正済み** |
| ⚫︎取引の年月日 | 52.3% | `transactionDate` | A |
| ⚫︎送料 | 49.8% | `shippingCost` | **C → 修正済み**(列は存在した) |
| ⚫︎その日の仕入れ合計金額(他商品含む) | 44.3% | `dailyPurchaseTotal` | **C → 修正済み** |
| ⚪︎奥行（cm） | 44.2% | `depth` | A |
| ⚪︎高さ（cm） | 43.8% | `height` | A |
| ⚪︎振込日 | 35.2% | `customFields.transferDate` | **B → 修正済み** |
| ⚪︎傷汚れ箇所等メモ | 22.3% | `damageNotes` | A |
| ⚫︎取引区分 | 19.5% | `transactionType` | **C → 修正済み** |
| ⚫︎取引相手の真偽の確認…方法 | 17.5% | `identityVerificationMethod` | **C → 修正済み** |
| ⚫︎住所 | 17.2% | `counterpartyAddress` | **C → 修正済み** |
| ⚫︎職業 | 16.8% | `counterpartyOccupation` | **C → 修正済み** |
| ⚫︎品目 | 15.3% | `usedGoodsItemType` | **C → 修正済み** |
| ⚫︎古物の特徴 | 14.6% | `customFields.usedGoodsFeature` | **C → 修正済み**(seed済みだった) |
| ⚫︎数量 | 14.0% | `purchaseQuantity` | **C → 修正済み** |
| ⚪︎材質 | 10.1% | `customFields.material` | **B → 修正済み** |
| ⚪︎全長（cm） | 9.7% | `overallLength` | **C → 修正済み** |
| ⚪︎取付タイプ | 4.3% | `mountType` | **C → 修正済み** |
| ⚪︎全長調節可否 | 3.4% | `lengthAdjustable` | **C → 修正済み** |
| ⚫︎記入メモ | 2.3% | `customFields.entryMemo` | **B → 修正済み** |
| ⚪︎コンディション評価(1〜5) | 1.1% | `conditionRating` | A |
| ⚪︎口金 | 0.1% | `customFields.socketType` | **C → 修正済み**(seed済みだった) |
| ⚪︎梱包サイズ | (新しい商品のみ) | `customFields.packageSize` | **C → 修正済み**(seed済みだった) |
| ⚪︎脚高 | (同上) | `customFields.legHeight` | **C → 修正済み**(seed済みだった) |
| ⚪︎座面寸法 / ⚪︎座面寸法(ソファ・椅子) | (同上) | `customFields.seatDimensions` | A(別綴りを追加) |
| ★市川メモ | (同上) | `adminMemo`(createOnly) | A |
| `<<出品情報>>` | (新しい商品のみ) | `listingNotes` | **C → 修正済み** |
| ☆販売予定価格（送料別大原記載） | (新しい商品のみ) | `plannedSalePrice` | **★C → 修正済み(本件)** |
| 商品名 / 商品カテゴリー / 材質 / ブランド / 配送設定 / 色 / サイズ / コンディションランク / 補修の内容 / 販売価格 / 配送方法 / 【出品用】* | 各1件 | — | **F**(値がラベル文字列そのもの = ZAICO上のテンプレート行。取り込むとゴミが入る) |
| ●販売日数 | — | — | F(`saleStartDate` から導出できる) |
| ●売却の優先度 | — | `customFields.salePriority` | A |

分類は指示書§16の A〜G:
A=正常反映 / B=必要だが未取得 / C=取得しているがDB未保存 /
D=DB保存済みだがUI未利用 / E=名称・型変換ミス / F=BELLOでは不要 /
G=BELLOで必要だがZAICOに無い

### 3.3 分類 D(保存されているがUIで使われていない)

現時点では該当なし。新たにマッピングした項目のうち、

- `listingNotes` … 在庫詳細の「販売情報」に表示欄がある ✅
- `shippingCost` … 在庫詳細の「D. 古物台帳」で表示される ✅
  (新規登録/編集フォームの入力欄からは意図的に外してある)
- `customFields.*` … 詳細画面の追加項目として自動表示される ✅

### 3.4 分類 G(BELLOで必要だがZAICOに無い)

| 項目 | 現在の入手元 |
|---|---|
| 送料判定用の**外形**寸法 | ZAICOの幅/奥行/高さは自由記述で、「座面直径34」のように座面寸法しか無い行がある。外形が確定できない場合は送料判定を行わない(推測しない) |
| BASE の item_id | ZAICOには無い。`BaseProductArchive`(BASE APIから267件取得済み)が保持 |
| 会話・注文との紐付け | ZAICOの範囲外 |

---

## 4. 既存データを壊さないための扱い(§18)

`mapZaicoOptionalAttributes` は以下を守っている(回帰テストで固定):

- 空文字・空白のみ・null の値は **1件も** 書き込まない(既存値を消さない)
- 数値化に失敗した値は **0にしない**。書き込まず警告として残す
  (「販売予定価格未取得を0円扱い」の禁止)
- 日付に変換できない値も同様
- `★市川メモ` は新規作成時のみ(`createOnly`)。再同期で人の追記を消さない
- `<<出品情報>>` は **値が空のときだけ** ZAICO の見出し装飾として無視。
  値を持つ場合は本文として取り込む

---

## 5. 実在商品での一致確認(§19)

`scripts/sync-zaico-items.ts`(既定 dry-run、`--apply` で書き込み)で、
ZAICO ID を指定した数件だけを同期できる。

### B005611(ZAICO 73116698)— 適用済み

| 項目 | 適用前 | 適用後 | ZAICO raw |
|---|---|---|---|
| quantity | 0 | **1** | `"1.0"` |
| plannedSalePrice | (無し) | **24800** | `"24800"` |
| listingNotes | (無し) | 出品情報の本文 | `<<出品情報>>` |
| counterpartyAddress | (無し) | 履歴あり | 同左 |
| counterpartyOccupation | (無し) | リサイクル販売業 | 同左 |
| purchaseQuantity | (無し) | 8 | `"8"` |
| transactionType | (無し) | 買受 | 同左 |
| identityVerificationMethod | (無し) | 対面している相手の… | 同左 |
| customFields.packageSize | (無し) | **家財B** | `⚪︎梱包サイズ` |
| customFields.usedGoodsFeature | (無し) | アルペール ソファ 椅子 サイドボード | 同左 |

再実行すると「変更なし」= ZAICO と BELLO の値が完全一致。

### B005610(ZAICO 73116696)— **適用していない**

この商品は `plannedSalePrice` に **28000 が手入力**されており、ZAICO側の
24800 で上書きすることになる。ZAICOの項目名が
「☆販売予定価格（送料別**大原記載**）」であることから ZAICO 側が正本と
読めるが、既存の入力値を消す判断は利用者のものなので実行していない。

**全件同期を回すと同じことが起きる。** 現在 `plannedSalePrice` に値が
入っている行は全5,313件中この2件だけなので、影響範囲はこの1件。

---

## 6. 全件へ反映するには

新しくマッピングした項目は、**次にその商品が同期されたときに**入る。
既存5,313件へ遡って入れるには全件同期が要る:

1. 設定 → ZAICO同期 から全件同期を開始する(`ZaicoSyncJob` が立つ)
2. `zaico-sync-worker` が5分ごとに続きを進める(ブラウザを閉じてよい)
3. ZAICO API のレート制限(約3req/秒)に合わせて間隔を空けるため、
   5,313件で相応の時間がかかる

このセッションでは全件同期を実行していない。5,313件への書き込みは
規模が大きく、上記 B005610 のような上書きも伴うため、利用者の判断で
開始するのが妥当と考えた。

---

## 7. 回帰テスト

`npm run verify:zaico-mapping`(45 assertions、全通過)

fixture は手書きの擬似データではなく **実際のZAICO応答をそのまま保存
したもの**(`zaico-verification/fixtures/zaico-raw-items.json`)。
「fixtureにも同じ架空の値を書いていたからテストが通っていた」という
失敗の仕方をしない。

固定している内容:

- 文字列の数量("2.0")が 2 になること、"abc" は null + 警告、"2.5" は切り捨て + 警告
- `☆販売予定価格（送料別大原記載）` が 24800 として入ること
- 全角/半角括弧の表記ゆれでも同じ項目として解決できること
- 古物台帳の各項目・寸法・CustomField が期待どおりの保存先へ入ること
- 空値・数値化失敗で既存値を壊さないこと
- `★市川メモ` の createOnly が維持されること
- **マッピング表が実在しないフィールドを指していないこと**(タイポ検出)
- 実応答に、値を持つ未マッピング項目が残っていないこと
