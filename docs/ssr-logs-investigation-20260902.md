# Amplify SSRログがCloudWatchへ出ない件 — 再調査

2026-09-02 / アプリ `d4hkkg7dty2du`（bello-inventory-staging）/ us-west-2

## 先に訂正

前回の報告で「Amplify Console でログ転送を有効化する操作が必要」と書いたのは
**誤り**でした。利用者の実測どおり、Console には転送のスイッチは存在せず、
画面自体が「Amplifyは自動的にAmazon CloudWatchにログを送信」と明記しています。

私は「Amplify APIに有効化フィールドが無い」ことから「ならConsole側にあるはず」と
**推論で埋めて**しまいました。無いものを在ることにした形で、実測で否定されました。

---

## 確定した事実

すべて読み取り専用の確認。AWS設定は一切変更していません。

| # | 確認したこと | 結果 |
|---|---|---|
| 1 | ロググループの存在（us-west-2 / us-east-1 / ap-northeast-1） | `/aws/amplify/*` は**どのリージョンにも無い** |
| 2 | コンピュートロールの信頼ポリシー | `amplify.amazonaws.com` / 条件なし。**正しい** |
| 3 | コンピュートロールの権限（対象ロググループARNに対して） | `CreateLogGroup` / `CreateLogStream` / `PutLogEvents` / `DescribeLogStreams` すべて **allowed** |
| 4 | リクエストがコンピュートに届いているか | `X-Cache: Miss from cloudfront` ＋ `Cache-Control: private, no-cache, no-store` → **オリジンに到達している** |
| 5 | アプリが標準出力へ書いているか | ローカルの production ビルド（`next start`）で `[bello] server started …` の出力を**確認済み** |
| 6 | CloudTrail 直近6時間の AccessDenied | **0件**（50件中） |
| 7 | CloudTrail の `CreateLogGroup` | バックエンドLambda（8/29〜8/30）のみ。**Amplifyからの試行は記録なし** |
| 8 | ブランチの `computeRoleArn` | キー自体が無い（アプリレベルを継承）。ブランチ上書きなし |
| 9 | アプリの platform / 作成日 | `WEB_COMPUTE` / 2026-08-29。デプロイは BUILD→DEPLOY→VERIFY すべて SUCCEED |

**要するに:** コンピュートは動いていて、アプリは書いていて、権限もあるのに、
Amplifyがロググループを作ろうとした形跡そのものが無い。

---

## 分からなかったこと（正直に）

**なぜAmplifyが出力を転送していないのかは、外側からは特定できませんでした。**

権限拒否なら CloudTrail に AccessDenied が残るはずですが0件で、
`CreateLogGroup` の試行も記録されていません。つまり「権限で弾かれている」
のではなく「そもそも呼ばれていない」状態です。

### IAMポリシーシミュレータについての注意（自戒）

調査の途中で `simulate-principal-policy` を使い、一度は
「`logs:DescribeLogGroups` が拒否されている＝これが原因」と考えました。
しかし検証を続けたところ、**結果は渡すリソースARN次第で変わる**ことが分かりました。

```
CreateLogGroup を対象ロググループARN付きで評価      → allowed
CreateLogGroup をリソース指定なし(=*)で評価         → implicitDeny
```

`CreateLogGroup` は確実に許可されているのに、後者では拒否と出ます。
つまり **implicitDeny の多くはシミュレータの引数由来の見かけ**であり、
これを根拠に原因を断定するのは誤りでした。報告前に気づけたので直しました。

---

## 唯一見つかった、AWSの標準構成との差

原因と断定はできませんが、**AWS自身の管理ポリシーと食い違っている箇所**が
1つだけあります。

`AdministratorAccess-Amplify`（AWS管理ポリシー v12）:

```
logs:DescribeLogGroups          →  Resource: arn:aws:logs:*:*:log-group:*
logs:CreateLogGroup             →  Resource: arn:aws:logs:*:*:log-group:/aws/amplify/*
logs:CreateLogStream, PutLogEvents
                                →  Resource: arn:aws:logs:*:*:log-group:/aws/amplify/*:log-stream:*
```

BELLOのインラインポリシー `BelloComputeRuntimeAccess` の `BelloSsrComputeLogs`:

```
logs:CreateLogGroup, CreateLogStream, PutLogEvents,
DescribeLogGroups, DescribeLogStreams
                                →  Resource: arn:aws:logs:us-west-2:203918843421:log-group:/aws/amplify/*
```

**5つのアクションを1つのResourceでまとめている。** AWS側は用途ごとに
3つへ分けており、とくに `DescribeLogGroups` だけは**ロググループ全体**
(`log-group:*`) を対象にしています。

`DescribeLogGroups` は「一覧を引く」種類の呼び出しで、特定のロググループへ
絞った指定と噛み合わないことがあります。Amplifyの転送処理が
「一覧を引いて → 無ければ作る」順で動いているなら、最初の一覧取得で
止まっている可能性があります。

**ただし CloudTrail に `DescribeLogGroups` の拒否は記録されていない**ので、
これが原因だという証拠はありません。「AWSの標準と違う唯一の箇所」という
だけです。

---

## 提案する次の一手

### 案1（推奨・小さい）: ポリシーをAWSの標準構成へ揃える

`BelloSsrComputeLogs` を、AWS管理ポリシーと同じ3分割へ変更する。

```json
{
  "Sid": "BelloSsrComputeLogsDescribe",
  "Effect": "Allow",
  "Action": ["logs:DescribeLogGroups"],
  "Resource": "arn:aws:logs:us-west-2:203918843421:log-group:*"
},
{
  "Sid": "BelloSsrComputeLogsCreateGroup",
  "Effect": "Allow",
  "Action": ["logs:CreateLogGroup"],
  "Resource": "arn:aws:logs:us-west-2:203918843421:log-group:/aws/amplify/*"
},
{
  "Sid": "BelloSsrComputeLogsWrite",
  "Effect": "Allow",
  "Action": ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
  "Resource": "arn:aws:logs:us-west-2:203918843421:log-group:/aws/amplify/*:log-stream:*"
}
```

- 広がるのは `DescribeLogGroups`（読み取り専用の一覧）の範囲だけ
- 書き込みは `/aws/amplify/*` のまま。他のロググループへは書けない
- 効かなければ元へ戻せる

**これはIAM権限の変更なので、ご承認をいただくまで実施しません。**

### 案2: AWSサポートへ問い合わせる

案1で変わらない場合。Amplify側の挙動としか考えられないため。
問い合わせに添える材料は上の「確定した事実」の表がそのまま使えます。
とくに **4・5・6・7**（コンピュートは動作、アプリは出力、拒否は0件、
Amplifyからの作成試行なし）が要点です。

---

## 実施していないこと

- AWS設定の変更（IAM・Amplify・CloudWatch のいずれも）
- 推測に基づく修正

`instrumentation.ts` の起動ログは入れたまま残します。転送が復旧した時点で、
ロググループの有無だけで確認できるようにしておくためです。
