# Amplify SSRログがCloudWatchへ出ない件 — 根本原因の特定

2026-09-02 / アプリ `d4hkkg7dty2du`（bello-inventory-staging）/ us-west-2

## 結論（1行）

**Amplify Hosting のログ配信は `CreateLogStream` を直接呼ぶだけで、
`CreateLogGroup` を一度も呼ばない。ロググループ `/aws/amplify/d4hkkg7dty2du`
が存在しないため、配信が毎回 `ResourceNotFoundException` で失敗している。**

権限の問題ではありません。**ロググループを1つ作れば解消する見込みです。**

---

## 決定的な証拠（CloudTrail）

```
eventName        : CreateLogStream
呼び出し元       : arn:aws:sts::203918843421:assumed-role/
                   BelloAmplifyStagingBackendDeploymentRole/AmplifyHostingLogDelivery
requestParameters: {
                     "logGroupName" : "/aws/amplify/d4hkkg7dty2du",
                     "logStreamName": "claude/inventory-management-system-5vbvc7/
                                       2026/09/02/<uuid>"
                   }
errorCode        : ResourceNotFoundException
errorMessage     : The specified log group does not exist.
```

読み取れること:

1. 配信を行っているのは**サービスロール** `BelloAmplifyStagingBackendDeploymentRole`
   のセッション `AmplifyHostingLogDelivery`。コンピュートロールではない。
2. 対象は Console がリンクしている `/aws/amplify/d4hkkg7dty2du` そのもの。
3. ログストリーム名に**対象ブランチ名が入っている** —— 配信対象の特定は
   正しくできている。
4. 失敗理由は権限ではなく「ロググループが無い」。
5. 短時間に何度も再試行しており、Amplify側は諦めずに送り続けている。

`CreateLogGroup` の呼び出しは、この配信セッションからは**一度も記録が無い**
（記録があるのはバックエンドLambdaのサービスロールによるもののみ）。

---

## 経緯と、私が途中で誤った点

### 誤り1: 「Console で有効化が必要」

Amplify API に有効化フィールドが無いことから推論で埋めた。利用者の実測
（Console にスイッチは無く「自動的に送信」と明記）で否定された。

### 誤り2: 「Amplifyからの試行がCloudTrailに記録されていない」

`lookup-events --max-results 50` を**フィルタ無し**で実行し、その50件が自分の
API呼び出しで埋まっていたのを「試行が無い」と読んだ。`EventName=CreateLogStream`
で絞ったところ、**大量に記録されていた**。

母集団を確認せずに「無い」と判断したのが原因。件数上限のある問い合わせで
「見つからない」は「存在しない」ではない。

### 誤り3: IAMシミュレータの結果を根拠にしかけた

`simulate-principal-policy` の `implicitDeny` は渡すリソースARN次第で変わる。
確実に許可されている `CreateLogGroup` すら、リソース指定なしでは deny と出る。
報告前に気づいて撤回した。

---

## 実施した変更と、その結果

### 適用 → 検証 → ロールバック（すべて完了済み）

ご承認いただいた案1（`BelloSsrComputeLogs` の3分割）を適用し、再デプロイ
（job 171 SUCCEED）と SSR リクエストで検証した。

| 確認項目 | 結果 |
|---|---|
| 1. `/aws/amplify/d4hkkg7dty2du` が作成されるか | **作成されず** |
| 2. ブランチのログストリームが作成されるか | **作成されず**（`ResourceNotFoundException`） |
| 3. `instrumentation.ts` の起動ログが届くか | **届かず** |

さらに、同じ `ResourceNotFoundException` が**ポリシー変更前の21:31から**
発生していたことを確認した（変更は21:43）。つまり**この変更に効果は無かった**。

ご指示のとおり、変更前のポリシーへ**ロールバック済み**です。

```
復元後: BelloMercariAndLineSecretAccess / BelloSsrComputeLogs / BelloMessagingAttachments
        （変更前と同一の3statement、アクション・リソースとも一致）
バックアップ: %LOCALAPPDATA%\BELLO\iam-backup\BelloComputeRuntimeAccess.<timestamp>.json
```

---

## 提案する対処

### 対処: ロググループを作成する

```
aws logs create-log-group \
  --profile Bello --region us-west-2 \
  --log-group-name /aws/amplify/d4hkkg7dty2du
```

- 空のロググループを1つ作るだけ。既存リソースには一切触れない
- 取り消しは `aws logs delete-log-group --log-group-name /aws/amplify/d4hkkg7dty2du`
- サービスロールには既に `CreateLogStream` / `PutLogEvents` の権限がある
  （`AdministratorAccess-Amplify`）ので、グループさえあれば配信は通るはず
- Amplify は再試行を続けているので、作成後すぐに流れ始める見込み

**保持期間の設定を併せて検討してください。** 既定は「無期限」で、
放置すると保管料が増え続けます。

```
aws logs put-retention-policy \
  --profile Bello --region us-west-2 \
  --log-group-name /aws/amplify/d4hkkg7dty2du \
  --retention-in-days 14
```

### 作成後に確認すること

1. ロググループが存在する
2. `claude/inventory-management-system-5vbvc7/YYYY/MM/DD/<uuid>` 形式の
   ストリームができる
3. `[bello] server started {...}` が届く（`instrumentation.ts` の出力）

3が届けば、SSRの標準出力がCloudWatchへ到達する経路が生きていることが確定し、
以後は EC出品画面の render error も digest 付きで追えるようになります。

---

## AWSサポートへ問い合わせる場合の材料

対処で解消すれば不要ですが、Amplify側の挙動としては報告に値します。

**質問の要旨:** WEB_COMPUTE アプリで Amplify Hosting のログ配信が
`CreateLogGroup` を呼ばず、ロググループが存在しない場合に配信が永久に
失敗し続けるのは意図した挙動か。Console は「自動的にCloudWatchへ送信」と
案内しており、利用者が手動でロググループを作る必要があるとは書かれていない。

**添える事実:**

| 項目 | 値 |
|---|---|
| アプリ | `d4hkkg7dty2du` / platform `WEB_COMPUTE` / 作成 2026-08-29 |
| ブランチ | `claude/inventory-management-system-5vbvc7` / framework `Next.js - SSR` |
| リージョン | us-west-2（Amplify・CloudWatch とも） |
| 失敗している呼び出し | `CreateLogStream` → `ResourceNotFoundException` |
| 呼び出し元 | サービスロールのセッション `AmplifyHostingLogDelivery` |
| 対象ロググループ | `/aws/amplify/d4hkkg7dty2du`（存在しない） |
| サービスロールの権限 | `AdministratorAccess-Amplify`（`CreateLogGroup` を `/aws/amplify/*` に対して保持） |
| `CreateLogGroup` の呼び出し | 配信セッションからは**記録なし** |
| デプロイ | BUILD / DEPLOY / VERIFY すべて SUCCEED |
| コンピュートの動作 | `X-Cache: Miss from cloudfront` でオリジン到達を確認済み |
| アプリの出力 | ローカルの production ビルドで起動ログの出力を確認済み |
