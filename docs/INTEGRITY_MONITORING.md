# データ整合性の定期監視（2026-09-04）

**自動修復は一切しません。** 検知して記録し、通知できる形にするところまでです。

---

## 1. 何を監視しているか

実データを**読むだけ**で20項目を数え、前回の値と比べます。

| 分類 | 項目 |
|---|---|
| 欠落 | `listingPartition` の無い在庫（一覧に出てこない） |
| 重複 | SKU / 同じZAICO在庫IDの在庫 / 同じ `externalMessageId` のメッセージ / 同じ `dedupeKey` の通知 |
| 孤児 | 削除記録の無い在庫を指す履歴 / 存在しない在庫を指す 出品下書き・チャネル出品・画像処理ジョブ・画像処理履歴・ZAICO連携リンク・メルカリ注文コンテキスト・会話 / 存在しない会話を指すメッセージ・通知 |
| 途中状態 | `PROCESSING` のまま止まった通知・画像処理 / `RUNNING` のままのZAICO同期 / `PUBLISHING`・`QUEUED` のままの出品下書き |
| 競合 | 同じ在庫の同じ項目を、別の担当が10分以内に書き換えた回数（lost update の跡） |

---

## 2. 判定は「絶対件数」ではなく「前回との差」

実データには**消してはいけない残骸**があります。存在しない在庫を指す履歴が314件分ありますが、
これは2026-08-30のZAICO重複作成事故で消された在庫の履歴で、古物台帳として残すべきものです。

毎回「異常314件」と出し続けると、そのうち誰も読まなくなります。見たいのは
「314のままか」「315に増えたか」です。

| 状況 | 判定 | 通知 |
|---|---|---|
| 前回の値が無い | NEW（基準値を作るだけ） | しない |
| 現在 = 前回 | PASS | しない |
| 現在 > 前回 | **FAIL**（新しい異常） | **する** |
| 現在 < 前回 | WARNING（修復か、検査対象の変化か） | しない（記録には残る） |
| 取得できなかった | **ERROR** | **する** |

**取得できなかった項目の基準値は書き換えません。** 0で上書きすると、翌日に本来の件数へ
戻ったときに「+314件の異常」と誤検知し、監視そのものが信用を失います。
初回かつ取得エラーなら基準値を作らず、次回また初回として扱います。

---

## 3. 実行方式

| | |
|---|---|
| 実行 | AWS Lambda `integrity-monitor`（Amplify Gen2 の `defineFunction({ schedule })`） |
| スケジュール | EventBridge Scheduler `cron(0 0 * * ? *)` UTC = **日本時間 毎朝9時**、ENABLED |
| 保存先 | DynamoDB `IntegrityCheckLogTable`（生CDK、`RemovalPolicy.RETAIN`） |
| 権限 | 監視対象12テーブルは **read-only**。書き込みは自分の記録用テーブルだけ（IAMで強制） |
| 通知 | CloudWatch アラーム → SNS トピック（購読先の登録だけ人手が要る。§5） |

新しいサービスは追加していません。`pricing-scheduler` / `image-processing-worker` /
`zaico-sync-worker` と同じ、既存の仕組みです。

判定ロジック（`lib/integrity/`）は**手元の `npm run verify:data-integrity` と共有**しています。
2箇所に書くと、片方だけ直った日に「監視は正常なのに手元では異常」というずれ方をします。

### 手元から実行する

```bash
AWS_PROFILE=Bello npm run verify:data-integrity                 # 数えて表示するだけ
AWS_PROFILE=Bello npm run verify:data-integrity -- --diff       # 前回と比べる
AWS_PROFILE=Bello npm run verify:data-integrity -- --diff --save # 基準値と履歴を更新
```

基準値の保存先は**Lambdaの環境変数から解決**します。`backend.ts` は全アプリ共有なので
`IntegrityCheckLog` テーブルは本番とStagingの2つ存在し、名前の部分一致で選ぶと
手元の実行とスケジュール実行が別の基準値を見る事故になるためです。

---

## 4. 実測（Staging）

| | 実測値 |
|---|---|
| Lambda 実行時間 | **Cold 4,083ms / Warm 2,127〜2,636ms** |
| メモリ | 512MB 割当・**149〜164MB 使用** |
| 初期化 | 301〜322ms |
| 読む件数 | 在庫5,329 + 履歴28,423 + 会話・メッセージ・通知ほか ≒ **約4万件** |
| 判定結果 | `{"overall":"PASS","failed":[],"errored":[]}` |

日次実行は1日1回なので**常にCold**（約4秒）です。

### 在庫履歴の走査を2回から1回にした件（実測の訂正）

当初、在庫履歴（28,423件）を「孤児の判定」と「同時編集の検知」で**別々に2回**
走査していたため、1回にまとめました。

ただし**実行時間は短くなっていません**。2つの走査はもともと `Promise.all` の中で
並行して走っていたので、片方を無くしてもクリティカルパスは変わらないためです。

| | Cold | 備考 |
|---|---|---|
| 2回走査（変更前） | 3,618ms | 1サンプル |
| 1回走査（変更後） | 4,083ms | 1サンプル。ばらつきの範囲で、改善は確認できない |

減ったのは**読み取り量（＝費用）**で、最大のテーブル1本ぶんです。
コミットメッセージに「実行時間もほぼ半分」と書きましたが、それは誤りでした。

### 費用（公開料金からの概算。実際の請求は請求ダッシュボードで確認してください）

| 項目 | 概算 |
|---|---|
| Lambda | 4.4秒 × 512MB × 30回 ≒ 67 GB-秒/月 → **月1円未満** |
| DynamoDB 読み取り | 約4万件・射影後で数十MB/回 × 30回。オンデマンド読み取りで **月数円** |
| EventBridge Scheduler | 月30回。無料枠の範囲 |
| CloudWatch Logs | 1回あたり数十行 |

**月あたり数円**で、現在の運用費に対して誤差の範囲です。

---

## 5. 異常通知

### 経路

```
Lambda が異常を検知
  ├─ ログへ  [integrity-monitor] ALERT <判定> …（人が読む用）
  └─ EMFで   BELLO/Integrity / IntegrityAlert = 1（機械が読む用）
       ↓
CloudWatch アラーム  bello-integrity-alert-<スタック名>
       ↓
SNS トピック  BELLO Data Integrity Alert
       ↓
   （購読先は未登録 — 下記「必要な操作」）
```

### 発火する条件

| 判定 | 意味 | メトリクス | 通知 |
|---|---|---:|---|
| PASS | 前回と同じ | 0 | **しない** |
| WARNING | 基準値より減った（314→313など） | 0 | **しない**（記録には残る） |
| **FAIL** | 基準値より増えた（314→315、重複0→1など） | **1** | **する** |
| **ERROR** | 検査そのものができなかった | **1** | **する** |

### 二重送信しない仕組み

アラームは**状態が変わったとき**にしか通知しません。正常時も 0 を出しているので
データ欠損にならず、異常の直後に必ず OK へ戻ります。同じ実行から2通飛ぶことはなく、
翌日また異常が出れば改めて1通飛びます。

### 通知に入る内容

```
[integrity-monitor] ALERT FAIL
BELLO Data Integrity Alert
発生日時: 2026-09-05T00:00:12.345Z
判定: FAIL
実行ID: c65fb15c-54c1-4049-b03a-b64f9db15297
履歴: <IntegrityCheckLogTable> / id=run#2026-09-05T00:00:12.345Z

整合性の異常を検知しました（1項目）
・削除記録の無い在庫を指す履歴（在庫数）: 314 → 315（+1）
```

正常な項目は載せません（本当に見るべき行が埋もれるため）。

### 実測での確認（2026-09-04）

通知経路を実際に動かして確かめました。**Productionデータは一切壊していません**
（§15。使ったのはLambdaの通常実行と、テスト用のログ行1本だけです）。

| 確認 | 方法 | 結果 |
|---|---|---|
| PASS → 通知しない | Lambdaを通常実行（`overall: PASS`） | メトリクス **0** を記録、アラームは **OK** のまま |
| FAIL → 通知経路が発火 | テスト用ログ行にEMFで 1 を1回だけ書き込み | メトリクス **1** を記録、アラームが **ALARM** へ遷移<br>`Threshold Crossed: 1 datapoint [1.0] was greater than or equal to the threshold (1.0)` |
| 異常のあと自動で戻る | 次のPASS実行（メトリクス 0） | **ALARM → OK へ自動復帰**（張り付かない） |
| WARNING → 通知しない | 単体テスト（基準値の減少） | メトリクス **0** |
| ERROR → 通知経路が発火 | 単体テスト（取得エラー） | メトリクス **1** |

アラームの状態遷移の全履歴（`describe-alarm-history`。これが正本です）:

```
22:35 JST  INSUFFICIENT_DATA → OK     PASS実行がメトリクス 0 を出した
22:43 JST  OK → ALARM                 テスト用のFAILがメトリクス 1 を出した（通知が飛ぶ）
23:43 JST  ALARM → OK                 次のPASS実行の 0 で自動復帰
```

**1回の異常につきALARMへの遷移は1回だけ**で、その後は自動的に OK へ戻ります。
翌日また異常が出れば、改めて1通だけ飛びます。

本番アプリ（`d1uy61lbnqm8ae` / main）側にはまだアラームとトピックがありません。
このブランチの変更が main へ入って backend が再デプロイされた時点で作られます。
Staging（`d4hkkg7dty2du`）側は作成済み・稼働中です。

**購読先は0件**（登録していないことを確認済み）。

### 通知までの遅れ（実測 約1時間）

評価期間を1時間にしているため、**メトリクスが出てからアラームが遷移するまで最大1時間**
かかります。実測でも datapoint 12:43 UTC → ALARM 13:43 UTC でした。

日次の監視としては実害が無いため、**この設計のままにしています**。
朝9時の実行で異常が出れば、通知は同じ日の10時ごろまでに届きます。
「その日のうちに気づく」ことが目的なので、数分の即時性は要りません。

短くすること自体は可能です（期間を5分にすれば数分で届きます）が、
理論上速くなるだけで運用上の違いが無いため、今回は変更していません。

### アラームの状態を確認するとき（注意）

**`--alarm-name-prefix` ではなく `--alarm-names` で、名前を完全一致で指定してください。**

```bash
aws cloudwatch describe-alarms --region us-west-2 \
  --alarm-names "bello-integrity-alert-<スタック名>" \
  --query 'MetricAlarms[0].StateValue' --output text
```

prefix 一致の `MetricAlarms[0]` を見ると、**デプロイ中に誤った状態を読みます**。
CloudFormation がスタックを更新する間、一致するアラームが一時的に2つ
（更新前のものと、作成中の新しいもの）存在し、`[0]` がどちらを指すかが揺れるためです。
実際にこれで「ALARM → INSUFFICIENT_DATA → ALARM と往復している」と誤認しました。

状態の履歴が正本です。遷移を確かめるにはこちらを見てください。

```bash
aws cloudwatch describe-alarm-history --region us-west-2 \
  --alarm-name "bello-integrity-alert-<スタック名>" \
  --history-item-type StateUpdate --max-records 10 \
  --query 'AlarmHistoryItems[].{t:Timestamp,s:HistorySummary}' --output text
```

### メトリクスフィルタではなくEMFを使っている理由

`AWS::Logs::MetricFilter` の作成には**ロググループが既に存在していること**が要ります。
ロググループはLambdaが初回実行時に作るので、まだ一度も走っていないアプリ（本番側）では
`ResourceNotFoundException` でスタック全体がロールバックします。
EMF なら決まった形のJSONをログへ出すだけなので、CloudFormation側に依存が生まれません。

### 必要な操作（人が行うもの）

**購読先はこちらでは登録していません。** 宛先は利用者が決めるもので、勝手に登録して
よいものではないためです。いちばん簡単なのはメール購読です。

```bash
aws sns list-topics --region us-west-2 \
  --query "Topics[?contains(TopicArn,'IntegrityAlertTopic')].TopicArn" --output text

aws sns subscribe --region us-west-2 \
  --topic-arn <上で出たARN> --protocol email --notification-endpoint <宛先アドレス>
```

実行するとAWSから確認メールが届くので、本文のリンクを開けば有効になります。
以降、FAIL / ERROR のときだけ届きます。

### 既存のLINE通知基盤へ繋ぐ場合

SNSからLINEへ直接は送れないため、間にひとつ必要です。

| 方式 | 必要な作業 | 判断 |
|---|---|---|
| SNS → メール | 上のコマンド1回 | **推奨**。今すぐ使える |
| SNS → Chatbot 等の既存連携 | 連携先の設定 | 契約・既存連携次第 |
| SNS → 小さなLambda → LINE | 新規Lambda＋`bello/line-notify-bot` の読み取り権限付与 | **今回は実施していない**。既存の通知履歴（`NotificationDelivery`）は「問い合わせに対する通知」専用で、重複防止キーが `channel:conversationId:sourceMessageId` に固定されている。監視結果を相乗りさせると通知履歴の意味と冪等性の設計が壊れるため、別作業とすべき |

## 6. 現在の基準値（2026-09-04 時点）

| 項目 | 基準値 |
|---|---|
| 削除記録の無い在庫を指す履歴 | **314** |
| 存在しない会話を指す通知 | **6** |
| 存在しない在庫を指す出品下書き | **1** |
| 上記以外の17項目 | **すべて 0** |

314 / 6 / 1 の由来は `DATA_INTEGRITY_REPORT.md` §2.5 を参照してください。
いずれも「消してはいけない」または「消すかどうかが業務判断」のものです。
