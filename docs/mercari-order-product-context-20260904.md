# メルカリShops 注文番号 → 商品Context の復元(2026-09-04)

対象: 追加指示 §50–§61 / §62–§71。

## 何が起きていたか(実データ)

Staging接続済みのGmailに届いた取引メッセージ3通

| Gmail ID | 受信 | inquiryId | orderId |
| --- | --- | --- | --- |
| 1a066b29d3ea7441 | 2026-09-03 09:56 | 2JW3nvubFxXmjVXzDbNEkr | order_2JW2rNd9i7WdFrivCjhfpw |
| 1a066dbcf343566c | 2026-09-03 10:41 | 同上 | 同上 |
| 1a066e472c5fc35c | 2026-09-03 10:50 | 同上 | 同上 |

について、社内通知はいずれも「対象商品：特定できませんでした」だった。
会話 `65e72302-…` の `inquiryContext` も `inventoryStatus: "NOT_FOUND"`、
`baseStatus: "NONE"`。

**原因はメールの情報不足ではない。** 3通とも商品名
「BoConcept Lugo / 北欧 デンマーク Morten Georgsen 名作 …」を含んでいた。
壊れていたのは探し方:

1. **購入された商品は「販売中」カテゴリから外れる。**
   実測で、この出品タイトルに対応する在庫 `B005614` はカテゴリ
   `4d321481-…`(= 発送完了)にあった。商品名照合は「販売中」だけを
   走査する(`loadOnSaleForNameScan`)ので、**原理的に当たらない**。
   BASE側の強い手がかりを要求する既存のフォールバック
   (`loadSyncLagFallbackForNameScan`)も、Mercariのメールには
   BASE商品URLが無いため発動しなかった。
2. **注文番号を鍵にした対応表が無かった。** 同じ注文の3通目でも
   1通目と同じ探索をゼロからやり直していた。
3. 在庫名は出品タイトルの前後に社内注記が付く
   (`EDI登録済【9/3午前中】BoConcept Lugo / …`)。語の集合で比べると
   93%一致=「ほぼ一致(0.85)」止まりで、確定閾値0.95に届かない。

なお `order_2JW2rNd9i7WdFrivCjhfpw` については、Gmailを注文番号で全期間
検索しても購入通知は見つからなかった(5件すべて取引メッセージ)。
この注文は購入通知がGmailへ届く前のものと考えられる。

## 直した内容

### 1. 購入通知メールを取り込み対象にする(§62/§63/§69)

実メールの形(2026-09-04 取得):

```
下記の商品を◯◯さんが購入しました。商品の発送をお願いします。

▼商品情報
商品名 : 【売約済】Vitra ヴィトラ Organic Chair …
商品価格 : ¥45,000
数量 : 1

▼注文情報
注文番号 : order_2JWDBkbJuYtXpRfLvaHaBF
…
▼配送先情報
https://mercari-shops.com/seller/shops/<shopId>/orders/2JWDBkbJuYtXpRfLvaHaBF
```

- `MercariMailKind` に `PURCHASE_NOTIFICATION` を追加。
  判定は**本文の定型文**で行い、件名は見ない(既存方針と同じ)。
  問い合わせの定型文を先に見て、購入通知は最後に置く ——
  「発送をお願いします」は一般的な言い回しなので、取り違えたときに
  「返信を作る側」へ倒れないようにする(§69 安全側)。
- `MercariMailParseStatus` に `PURCHASE_NOTIFICATION` を追加。
  `NOT_INQUIRY` と**分けた**のが肝で、一緒にすると「取り込まない」で
  捨てられ、購入時点でしか手に入らない対応を毎回取り逃す。
- 購入通知では **Conversation / Message / ReplyDraft /
  NotificationDelivery を一切作らない**(§63)。
- Gmailの検索条件は変更不要 —— 送信元が同じ
  `no-reply@mercari-shops.com` なので既定の条件で拾える。

### 2. MercariOrderContext(§51/§64)

`amplify/data/resource.ts` に新モデル。識別子は `orderId` そのもの
なので、同じ注文のメールを何度取り込んでも行は1つ。

Conversation へ相乗りさせなかった理由は §53:
`inquiryId`(会話スレッド)と `orderId`(注文)は別の識別子で、
1つの注文に複数スレッドが立ちうる。会話の行へ入れると、別スレッドから
同じ注文の商品を引けない —— それを可能にするのがこの表の目的。
会話側の `inquiryContext` は従来どおり会話ごとの文脈を持つ。

保存は DynamoDB 直結(`lib/messaging/mercari/orderContextStore.ts`)。
理由は `webhookStore.ts` / `contextStore.ts` と同じで、定期実行の
スクリプトには Cookie が無く AppSync では書けないため。

マージ規則(`mergeOrderContext`、純粋関数)の不変条件:

- `undefined`/`null` で既存値を潰さない(購入通知で確定した商品名を、
  後続の断片的な取引メッセージが消さない)。
- 一度 `RESOLVED` になった在庫を、後の未解決な結果で戻さない(§70 ケースH)。
- `evidenceSource` は強い根拠(購入通知)を残す。
- `inquiryIds` / `sourceGmailIds` は集合として足す(重複しない)。

### 3. 復元の優先順位(§65)

`lib/messaging/mercari/orderProductContext.ts`:

1. 会話Context(pipeline 側で引き継ぐ)
2. **購入通知で作った対応表** ← 通常ケースの主経路
3. 同じ inquiryId の過去情報(会話Contextに含まれる)
4. 同じ orderId の既存情報(= 対応表そのもの)
5. 保存済みGmailデータ(取り込み時に対応表へ入っている)
6. Gmail API検索 ← **保存済みで復元できないときだけ**(§56)

問い合わせのたびにGmailを引く構造にはしていない。

### 4. 購入済み注文としての在庫照合(§50/§64)

`resolveProductFromInquiry({ purchasedOrder: true })` を追加。

- 名前照合の範囲を「販売中」に限らず、「破棄」だけを除いた範囲で探す
  (`loadOrderScopeForNameScan`)。
- 誤特定を避けるため、**広げた範囲から採るのは出品タイトルが一致した
  候補だけ**(`OFFICIAL_TITLE_MATCH_PREFIX` で判定)。ブランド名や語の
  断片の積み上げで過去在庫を拾うことはない。
- 販売中の結果は捨てず、確信度の高いほうを採る。

`scoring.ts`:

- `MatchSignals.baseTitles` → `officialTitles` へ改名。BASEの商品ページ
  タイトルとメルカリShopsの出品タイトルは同じ性質(BELLOが自分の在庫名から
  起こしたもの)なので、名前を出所に縛らない。
- **在庫名が出品タイトルを丸ごと含む**場合を完全一致と同じ配点(0.96)に。
  社内注記が前後に付いただけ、という関係は語の重なり率とは質が違う証拠。
  短いタイトルでの誤爆を避けるため語数の下限(4語)を置いた。
  実測: `B005614` 0.96(確定)/ `B005186` 0.70(別個体、確定させない)。

### 5. 会話Contextへ注文情報を保持(§55)

- `IdentifiedProductContext.channelProductName` を追加。
  BASE商品でも在庫でもない**第三の確定情報**として持つ。
- `OrderContextState` に `itemAmountYen` / `shippingFeeYen` /
  `couponDiscountYen` / `totalAmountYen` を追加。
- `knownFacts()` が `channelProductName` も「対象商品」として返すので、
  顧客へ商品名を聞き返す材料にならない(§54)。

既存の保存形式は `parseConversationContext` の既定値マージでそのまま
読める(新項目は null)。

### 6. 顧客へ内部の不足を転嫁しない(§54)

`decideUrlRequest` の `customerCanProvideUrl` を、チャネルに加えて
**注文番号の有無**でも false にする。注文があるなら、どの商品かは
メルカリShops側で確定していて、BELLOが紐付けられていないだけ。
未特定時の `unresolvedFacts` も
「注文番号(order_…)は把握していますが、対応するBELLO在庫を特定できません
でした。在庫データ側で確認してください(お客様への確認は不要です)。」
という内部向けの文言にした。

### 7. 社内LINE通知(§58)

`ReplyEvidence.channelProduct` を追加し、`productLines()` に
「販売チャネルの商品：特定できました」の分岐を足した。BASE商品の分岐と
同じ考え方で、**未確定なのは「どのBELLO在庫か」の一点だけ**であることが
読めるようにする。注文情報のセクションには金額も出す(取れなかった項目は
行ごと出さない —— 「送料：不明」は「送料無料だったかも」と読まれうる)。

2通目(顧客へ貼り付ける返信本文)は従来どおり変更なし。

### 8. バックフィル(§59/§67)

`npm run backfill:mercari-orders`。会話・メッセージ・通知のモジュールを
**import していない**ので、うっかり呼ぶこともない。既に商品名も在庫も
確定している注文は在庫の再照合を省く。

## 回帰テスト

`npm run verify:mercari-order-context`(60件、ネットワーク・AWS不要)。
ケースA〜Hをすべて含む。

## Staging実測(2026-09-03 デプロイ後)

### バックフィル(§59/§67)

```
npm run backfill:mercari-orders -- --limit 300
  対象メール          : 300件
  購入通知            : (Gmail内の「発送をお願いします」メール)
  注文番号あり        : 148件
  対応表へ登録        : 84件
  うち在庫まで特定    : 43件
  注文の実数          : 61件
```

登録後の `MercariOrderContext`:

| 項目 | 件数 |
| --- | --- |
| 注文 | 61 |
| 商品名あり | 61 |
| 在庫まで特定(RESOLVED) | 43 |
| 購入通知由来 | 32 |
| うち問い合わせスレッドが1つも無い注文 | 23 |

購入通知だけの注文が23件あり、そのどれにも Conversation は作られていない
(§63)。バックフィル前後で Conversation / Message / NotificationDelivery /
ReplyDraft はいずれも増えていない。

### 新着3件の再処理(§57/§68)

`npm run verify:mercari-order-live -- --reprocess`

| Gmail ID | inquiryId | orderId | 処理前 | 処理後 |
| --- | --- | --- | --- | --- |
| 1a066b29d3ea7441 | 2JW3nvubFxXmjVXzDbNEkr | order_2JW2rNd9i7WdFrivCjhfpw | `inventoryStatus=NOT_FOUND` 商品名なし | `RESOLVED` 在庫 **72235169** |
| 1a066dbcf343566c | 同上 | 同上 | 同上 | 同上 |
| 1a066e472c5fc35c | 同上 | 同上 | 同上 | 同上 |

- 同一orderIdの既存メール: **5件**(いずれも取引メッセージ。この注文の
  購入通知はGmailに存在しない)。商品名は5件すべてから取得できる。
- Inventory照合: `72235169`(0.96)/ 次点 `69878144`(0.70) —— 差が
  十分あるので候補が割れない。
- BASE照合: 該当なし(メールに商品URLが無いため手がかりが無い)。

社内通知の「対象商品」欄:

```
送信済み(当時)          いま作った場合
■ 対象商品              ■ 対象商品
特定できませんでした     商品名：EDI登録済【9/3午前中】BoConcept Lugo / …
                        在庫ID：72235169
```

既存の通知は再送も書き換えもしていない(`status=SENT` のものは
`canSend` が送信前に止める)。会話Contextには
`order.orderId` / `identifiedProduct` が保存され、以後の短いメッセージでも
商品・注文を引き継げる状態になった。

### 通常の取り込み(§70 ケースG)

`npm run ingest:mercari-mail`

```
取得 30件 / 新規取り込み 1件 / 取り込み済み 29件 / 購入通知 0件 / エラー 0件
```

購入通知は `purchaseMailGmailIds` により「取り込み済み」として弾かれ、
対応表も通知も増えない。新規1件は本物の商品問い合わせで、こちらは
従来どおり会話が作られている(mercari会話 23 → 24)。

## 既知の残件(この作業の範囲外)

3通目「メールにて写真をお送りいたしました。」は、返信案の生成が
`CLAIMS_UNSENT_ATTACHMENT` で3回とも不合格になり、返信案が作られない。
お客様は**メルカリShopsの外(メール)で**写真を送っており、BELLO側の
会話には添付が届いていないため、直前のコミット(d8e6fc5)の検査が
「受け取っていない写真に言及している」として弾いている。商品Contextの
復元とは別の問題なので、ここでは変更していない(社内通知は【要確認】)。
