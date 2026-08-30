# 商品画像自動加工UX明確化・在庫一覧チェックボックスの用途確定

作成日: 2026-08-30。対応指示書: 「不具合修正・ZAICO同期重複根絶・
EC出品UI改善・画像自動加工 完全自律実装指示書」§7/§12。

## 現行実装の調査(推測ではなくコードを読んで確認)

画像自動加工の**バックエンド自体は既に完成していた**:
`lib/imageProcessing/jobService.ts`の`enqueueProcessingJob`(冪等性
チェック込み)、`app/actions/imageProcessing.ts`の
`reprocessImageAction`(§12「手動再加工」、`triggerType:
"MANUAL_REPROCESS"`で既にカテゴリ非依存)、`listImageProcessingVersionsAction`、
`rollbackImageVersionAction`はいずれも実装済みで、
`app/inventory/ImageProcessingPanel.tsx`として在庫詳細ページに
既にマウントされていた(placeholderやmockではない)。

問題は**UI側の分かりにくさ**だった:

1. 商品全体を1回で加工開始する明確なボタンが無く、画像1枚ごとの
   小さな「再加工」テキストリンクしかなかった。
2. **未加工の画像にも「再加工」というラベルが表示されていた**——
   「まだ一度も加工していないのに『再加工』と言われる」という、
   ユーザーが「何をすればいいか分からない」と感じた直接の原因。
   (実際にはこのボタンを押せば処理は始まる——ラベルの問題であって
   機能自体は動いていた。)
3. 加工前/加工後を実際の画像で見比べる手段が無かった(状態ラベルの
   文字だけ)。
4. 在庫一覧のチェックボックス(`InventoryTable.tsx`)が
   `checked`/`onChange`を一切持たない、**実質的に完全に死んだUI要素**
   だった——クリックしても何も起きない(禁止事項そのもの)。

## 修正内容

### 1. 商品単位の明確なボタン(§12.3)

`app/inventory/ImageProcessingPanel.tsx`に「画像を自動加工」という
はっきりしたボタンを新設(既存の「◯/◯加工完了」表示の隣)。未加工・
失敗・要確認の画像だけをまとめて`reprocessAllImagesAction`
(新規Server Action、既存の`enqueueProcessingJob`をループで呼ぶだけ
——新しい加工ロジックは追加していない)へ渡す。既にREADYの画像は
巻き込まない(付録B「再加工で全画像を巻き込む処理」の禁止)。

### 2. ボタン文言の状態別出し分け(§12.2の誤解の直接対処)

`reprocessButtonLabel()`(新規、純粋関数):
- 未加工 → 「加工する」
- 失敗/リトライ上限 → 「再試行」
- 加工済/要確認 → 「再加工」

### 3. 加工前/加工後の比較(§12.5)

`BeforeAfterToggle`(新規、`ImageProcessingPanel.tsx`内)——
「加工前/加工後を見る」で開閉するside-by-side表示。既存の
`useInventoryImageUrl`フック(任意のS3キーを署名URLへ解決)を
そのまま再利用し、新しい画像配信経路は追加していない。開いた時だけ
署名URLを要求する(常時表示による無駄な負荷を避ける)。

### 4. 在庫一覧チェックボックスへの実際の用途付与(§7/§12.8)

新設`InventorySelectionProvider`(`DirectEditProvider`と全く同じ
「ツールバーとテーブル間でContext共有」パターン)で選択状態を管理し:
- `InventoryTable.tsx`: ヘッダーの「すべて選択」チェックボックス+
  各行のチェックボックスを実際の選択状態に配線(以前は`checked`/
  `onChange`が無く、押しても何も起きなかった)。
- `BulkImageProcessingControl`(新規、`InventoryToolbar.tsx`に設置):
  選択件数が0件のときは何も表示せず、1件以上選択すると「選択した
  商品の画像を一括自動加工」ボタンが現れる。新規Server Action
  `bulkReprocessInventoryImagesAction`(複数商品を横断し、各商品の
  未加工/失敗/要確認画像だけをまとめて予約する)を呼ぶ。

この用途がチェックボックスに与えられたことで、§7.3「有効な一括操作が
存在しないなら削除、存在するなら残す」の判断は「残す」で確定した
(削除ではなく、実際に機能する一括操作を後付けした)。

モバイル幅の`InventoryCardList`(P0-4で新設したカード型一覧)には
チェックボックスを持ち込んでいない——同コンポーネント自身の既存の
設計方針(「列表示設定・一覧直接編集はこのビューでは扱わない」)と
同じ理由で、狭い画面へ一括選択UIを持ち込むのは意図的なスコープ外
とした。

### 5. カテゴリ変更トリガーは維持(§12.7)

既存の「撮影待ち→出品待ち」カテゴリ遷移トリガー
(`triggerImageProcessingIfNeeded`)は削除していない——通常の業務
フローに沿って自動的に処理が始まる、という既存の利便性は正当な価値が
あると判断した。今回追加した明示的ボタンにより「カテゴリ変更に
**依存しない**」(§12.7の要件)ことは満たしつつ、両方の入口が
共存する設計とした。

## テスト・検証

- `scripts/verify-image-processing.ts`に7件追加(既存36件+新規7件=
  43件、全green)——`reprocessButtonLabel`の状態別出し分け、
  `BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES`がREADYを含まないこと。
- `e2e/inventory-bulk-image-processing.spec.ts`(新規、実Chromiumで
  デスクトップ幅1280pxを実行) —— 「チェックボックスが実際に
  checked状態を持つ」「1件選択で一括ボタンが現れる」「チェックを
  外すとボタンが消える」「ヘッダーの『すべて選択』が実際に全行へ
  伝播する」を実機で確認——「チェックしたのに何も起こらない」の
  逆(=チェックが実際に意味を持つ)を、コードレビューではなく実際の
  ブラウザ操作で検証した。
- `tsc`/`next lint`/`synth:check`/`npm run build`/既存
  `e2e/inventory-mobile.spec.ts`(モバイル密度回帰、13/13)全てgreen。

## 正直な残課題

- 実際のAWS書き込み(`enqueueProcessingJob`→DynamoDB
  `ProcessingJob.create()`)自体は、このセッションのAWS認証情報が
  無効なため実機検証できていない(`docs/aws-staging-reverify-20260830.md`
  参照)。E2Eテストは「UIの選択状態配線」までを実機確認しており、
  実際の画像加工パイプライン(Lambda worker、実sharp処理)は
  `scripts/verify-image-processing.ts`のAWS非依存部分のみ検証済み
  ——これは今回新規に生まれた制約ではなく、既存のimage-processing-worker
  Lambda全体がこのラウンド以前から抱えていた制約と同じもの。
- 実BELLO家具写真でのPoC(構図補正・床クリーニング等の実際の
  仕上がり確認)は引き続き未実施(実画像テストセットがこの
  セッションに存在しないため)。
