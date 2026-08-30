# AWS認証情報・Staging到達性の再検証(第六ラウンド P0-6/P0-7)

作成日: 2026-08-30。第五ラウンドの結論(BLOCKED)を鵜呑みにせず、この
ラウンド独自に3種類の実コマンドで再検証した記録。

## 結論(正直な記録)

**このセッションから実際にAWSへ認証済みの操作を行うことはできない
——ただし第五ラウンドとは異なる、より具体的な原因が判明した。**

- ネットワーク到達性そのものは問題ない: プロキシ経由で実際に
  `sts.us-east-1.amazonaws.com`/`ssm.us-east-1.amazonaws.com`へHTTPS
  接続が確立し、AWS側から**実際にAWSがフォーマットしたエラー応答**が
  返ってきている(接続タイムアウトやTLSハンドシェイク失敗ではない)。
- 環境変数`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`は**存在する**
  (第五ラウンドでは認証情報自体が見当たらなかった可能性があるのに対し、
  今回はそれとは異なる状況)。
- しかしその中身はAWS側から見て**無効な認証情報**(実在のAWSアカウント
  に紐づかない、テスト用/プレースホルダー値と推測される)——3つの独立
  したコマンドすべてが同一の結論(認証拒否)に到達した。

## 検証手順(実行した3コマンドと生の結果)

1. **AWS STS GetCallerIdentity**(`@aws-sdk/client-sts`、このリポジトリの
   既存依存関係をそのまま使用):
   ```
   ERROR InvalidClientTokenId The security token included in the request is invalid.
   ```
2. **`npx ampx sandbox --once`(AWS_REGION未設定)**:
   ```
   [InvalidCredentialError] Failed to load default AWS region
     ∟ Caused by: [Error] Region is missing
   ```
   (リージョン未設定という、認証情報の中身を見るより前の設定不備。
   AWS_REGION=us-east-1を設定して再実行。)
3. **`npx ampx sandbox --once`(AWS_REGION=us-east-1)**:
   ```
   [SSMCredentialsError] UnrecognizedClientException: The security token included in the request is invalid.
     ∟ Caused by: [UnrecognizedClientException] The security token included in the request is invalid.
   Resolution: Make sure your AWS credentials are set up correctly and have permissions to call SSM:GetParameter
   ```

1.と3.が同じ結論(`InvalidClientTokenId`/`UnrecognizedClientException`
——いずれも「認証情報の値自体が不正」というAWS側のエラーコードで
あり、権限不足(`AccessDenied`)でもネットワーク到達不能でもない)に
独立して到達したことが、この結論の裏付けになる。

## P0-6(Staging App `d4hkkg7dty2du`への再デプロイ試行)

上記の通り、`ampx sandbox`(Amplifyバックエンドの実デプロイコマンド)は
認証情報の検証段階で失敗するため、Staging Appへのデプロイは実行
できなかった。**Production App `d1uy61lbnqm8ae`・Production Role・
既存ZAICO Secretには一切触れていない**(そもそも認証情報が無効な
ため、意図の有無に関わらずどのAWSリソースへも到達できていない)。

このラウンドで`amplify/data/resource.ts`へ加えたスキーマ変更
(P0-5の`listingPartition`/`listUpdatedAt`フィールド・GSI、P0-2の
`ShippingRate`/`ShippingImportBatch`関連フィールド)は`npm run
synth:check`(実際のCDK synthを伴う、AWSクレデンシャル不要な
ローカル検証)で構文・スキーマレベルの正しさを確認済みだが、**実際に
Staging環境へデプロイして初めて確定する類の検証(実際のDynamoDB
テーブルへの実データでのGSI Query結果、実際のCloudFormationスタック
更新が成功するか等)はこのセッションでは実施できていない**——完了
報告ではこれを`LOCAL_VERIFIED`ではなく`PARTIAL`として扱う。

## P0-7(ZAICO Background Job実AWS検証)

同じ理由(認証情報が無効)により、Staging環境上のLambda
(`zaico-sync-worker`)を実際に呼び出しての
create/update/resume/lease/unchanged-fast-path/retry-DLQの実機検証も
実施できない。第五ラウンドP0-Aで構築済みのLambdaインフラ
(`amplify/functions/zaico-sync-worker/`)自体への変更は今回追加で
入れた(P0-5のlistingPartition/listUpdatedAt設定、上記コミット参照)が、
これも`npm run synth:check`によるCDK synthレベルの検証
(Lambdaのバンドルが実際に成功することを含む)より先へは進めていない。

## この結果をもってローカル実装を止めなかったこと

指示書の禁止事項「AWS credential不在でローカル実装まで停止」に従い、
この再検証結果を確認した後もP0-1〜P0-5のローカル実装・ローカル検証
(tsc/eslint/synth:check/verify:*/production build/Playwright)は
全て実施済み・全てgreenである(各P0項目の個別docおよび最終報告書
参照)。
