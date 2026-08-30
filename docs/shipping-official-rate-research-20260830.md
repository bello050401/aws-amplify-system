# 家財おまかせ便 埼玉発 公式料金データ取得 — 調査記録・実装記録(第六ラウンド P0-2)

作成日: 2026-08-30。

## 今回、過去のBLOCKED判定を無条件に継承せず再検証した内容

過去ラウンドは「WebFetchがEGRESS_BLOCKED」とだけ記録していた。今回は
指示書の要求通り、**独立した3つの手段**でゼロから再検証した:

1. **WebFetch**: `https://form.008008.jp/mitumori/PKZI0100Action_doInit.action`
   と`https://www.008008.jp/`の両方に対し実行 → いずれも
   `EGRESS_BLOCKED`(即座に、コード上の構造的エラーとして)。
2. **WebSearch**: 公式サイトのURL自体は実際に発見できた
   (`https://form.008008.jp/mitumori/PKZI0100Action_doInit.action`)。
   ただし検索エンジンの要約は、動的にレンダリングされる料金表本体の
   実数値までは含まない(表の存在・SS〜G 9ランク制・地域Ⅰ〜Ⅺという
   区分の存在自体は確認できたが、実際の金額は取得できず)。
3. **実Chromiumブラウザでの直接navigation**(Playwright、`/opt/pw-browsers/chromium`):
   `net::ERR_TUNNEL_CONNECTION_FAILED` — ブラウザの実ネットワークスタック
   も同じegress proxy制限を受けている。

**結論**: この開発sandbox環境からは、公式ドメイン(form.008008.jp /
www.008008.jp)へ一切到達できない。これは3つの独立した技術的手段全てで
再現された、機械的に確定した事実であり、「試行を怠った」結果ではない。
ただし、これは**この開発sandbox固有のネットワークポリシー**であり、
AWS Amplify Hosting上の実際のSSRコンピュート/Lambda(通常デフォルトで
外部インターネットへのegressを持つ)が同じ理由で失敗するとは限らない。

## 非公式サイトの扱い(禁止事項の遵守)

WebSearchでは複数の代理店/販売店が公式料金表の一部を転載しているページ
(rakuten.ne.jp/gold/viviandcoco/kazai.html、antique-alver.com/fee-table/、
des-moa.com/rakuraku_price/等)も見つかった。指示書§335
「非公式サイトの料金表をDBのverified値として使用しない」に従い、
**これらの数値は一切DBへ投入していない**——存在を確認しただけで、
verified dataとしては扱っていない。

## 実装したこと(データ取得自体ができない中での最大限の前進)

### 1. ShippingRate DBスキーマ拡張(§10、破壊的置換なし)

既存field(originArea/destinationArea/sourceReference等)は維持しつつ、
`taxIncluded`/`currency`/`acquiredAt`/`status`(VERIFIED/UNAVAILABLE/
STALE/UNCONFIRMED)/`rawHash`/`importBatchId`を追加。`price`は
`UNAVAILABLE`(サービス対象外)行を0円で埋めないよう`null`許容へ変更
——既存データ(税込前提・price必須だった行)の読み取り互換性は
`toShippingRateRecord`のフォールバックで維持。

### 2. ShippingImportBatchモデル新設(§11)

import batch 1回につき1行。expected/verified/unavailable/missing/
failed/changed/unchangedの各件数、lease(二重実行防止)、checkpoint
(resume用)、triggeredByを保持。

### 3. 純粋ロジック(実データ取得の有無に関わらず今すぐ有効)

`lib/shipping/importer.ts`:
- `buildExpectedMatrix`: 全destination×全rankの期待組合せを生成
  (§9)。
- `computeMatrixCompleteness`: 期待matrixと実際の取得結果を照合し、
  verified/unavailable/missing件数とcompletenessRatioを計算——
  missingを0円で埋めず、正直に列挙する(§9/§83「全国matrix
  completenessが100%でない場合は『全取得完了』と報告しない」)。
- `computeRawHash`: 取得値の差分検出(§25「rawHash一致はDB writeを
  抑制」)。
- 14件の新規テストで検証済み(`verify:shipping`、66件中の新規分、
  既存52件は無傷)。

### 4. Importerオーケストレーション + 正直な失敗経路

`runShippingRateImportBatch`は実際に`fetch()`でHTTPリクエストを試みる
(`Form008008RateSource`)——「動かないふりをするダミー」ではなく、
到達可能な環境ではそのまま機能する設計。このsandbox環境では
`ShippingImportNetworkError`で失敗し、`ShippingImportBatch`へ
`status=FAILED`+実際のエラー内容を記録するだけで、**既存の
ShippingRateデータには一切書き込まない**(§105「公式サイト障害時に
既存verified ratesを削除しない」)。

仮にネットワーク到達に成功したとしても(実デプロイ環境等)、その先の
実際のフォーム送信契約(input name・複数ステップの有無)は一度も
観測できていないため、`ShippingImportUnconfirmedContractError`で
明示的に停止する——推測でPOSTパラメータを埋めることはしない
(§instructions「外部サイトのアクセス制御を回避しない」「推測実装
禁止」)。

### 5. Admin UI

設定画面(`ShippingRatePanel.tsx`)に「埼玉発料金データ」状態表示
(最終実行日時・取得済み/配送不可/未取得/失敗件数)+「公式料金を
更新」ボタンを追加(ADMIN限定)。

## この回で完成しなかったこと(正直な記録)

- **実際の埼玉発料金matrixの取得**: 上記の理由でネットワーク到達
  そのものが不可能なため、実施できていない。
- **公式フォームの実際の送信契約の確認**: 到達できないため、当然
  未確認のまま。

## 唯一、人間の観測が必要な残作業

`docs`の他の箇所とは異なる種類のブロッカー——AWS認証(P0-6)とは別に、
**実際にインターネットへ到達できる環境からこのページを一度操作し、
ブラウザの開発者ツールのNetworkタブでリクエスト内容(フォームの
input name・送信先・複数ステップの有無)を確認する**ことでしか
埋められない。これはAWS SSO/MFAのような「認証情報の入力」ではなく、
「観測」そのものが必要な性質のブロッカーであり、今回追加された
真に人間本人にしかできない操作として最終報告に記録する。

## 回帰確認

`tsc`/`next lint`/`npm run build`(production)/`synth:check`
/`verify:*`全9スイート(326 assertion)/`playwright test`(9/9)
——全てgreen。
